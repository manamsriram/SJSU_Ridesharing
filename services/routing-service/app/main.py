import asyncio
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException
from functools import partial
from pydantic import BaseModel
import googlemaps
import redis
import json
import hashlib
import os
import logging
from typing import Optional
from dotenv import load_dotenv

# K8s manifest update - port fix (8002)
from app.secret_loader import load_mounted_secrets

logger = logging.getLogger(__name__)

load_dotenv()
load_mounted_secrets()

app = FastAPI(title="Routing Service", version="1.0.0")


# Initialize Google Maps client
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
if not GOOGLE_MAPS_API_KEY:
    print("⚠️ GOOGLE_MAPS_API_KEY not set - routing will fail")
    gmaps = None
else:
    gmaps = googlemaps.Client(key=GOOGLE_MAPS_API_KEY)

# Initialize Redis client — falls back gracefully if unavailable
in_kubernetes = os.getenv("KUBERNETES_SERVICE_HOST") is not None
default_redis_url = "redis://redis:6379" if in_kubernetes else "redis://127.0.0.1:6379"
REDIS_URL = os.getenv("REDIS_URL", default_redis_url)
CACHE_TTL = int(os.getenv("ROUTE_CACHE_TTL", "3600"))  # 1 hour default

try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
    redis_client.ping()
    print(f"✅ Connected to Redis at {REDIS_URL}")
except Exception as e:
    print(f"⚠️ Redis connection failed: {e} — caching disabled")
    redis_client = None

# Dedicated executor for gmaps calls — these are I/O-bound (waiting on the Google
# Maps API), so a generous worker count doesn't fight the pod's CPU limit. A single
# search can fire up to ~20 concurrent route calls; the asyncio default executor
# (min(32, cpu_count()+4)) can be starved under constrained CPU limits in GKE Autopilot.
ROUTE_EXECUTOR_WORKERS = int(os.getenv("ROUTE_EXECUTOR_WORKERS", "32"))
route_executor = ThreadPoolExecutor(max_workers=ROUTE_EXECUTOR_WORKERS)


class RouteRequest(BaseModel):
    origin: str
    destination: str


class RouteResponse(BaseModel):
    distance_meters: int
    distance_miles: float
    duration_seconds: int
    polyline: Optional[str] = None


class OptimizeRequest(BaseModel):
    origin: str
    destination: str
    waypoints: list[str]


class OptimizeResponse(BaseModel):
    distance_meters: int
    distance_miles: float
    duration_seconds: int
    waypoint_order: list[int]
    polyline: Optional[str] = None


def get_cache_key(origin: str, destination: str) -> str:
    key_str = f"route:{origin}:{destination}".lower()
    return hashlib.md5(key_str.encode()).hexdigest()


def _cache_get(key: str) -> Optional[dict]:
    if not redis_client:
        return None
    try:
        cached = redis_client.get(key)
        return json.loads(cached) if cached else None
    except Exception:
        return None


def _cache_set(key: str, data: dict) -> None:
    if not redis_client:
        return
    try:
        redis_client.setex(key, CACHE_TTL, json.dumps(data))
    except Exception:
        pass


def calculate_route_core(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> dict:
    """
    Core route calculation using Google Maps Directions API.
    Blocking — always call via run_in_executor from async context.
    """
    if not gmaps:
        raise RuntimeError("Google Maps API not configured")

    origin = f"{origin_lat},{origin_lng}"
    destination = f"{dest_lat},{dest_lng}"

    # Rough epsilon check (~11 meters per 0.0001 degree)
    if abs(origin_lat - dest_lat) < 0.0001 and abs(origin_lng - dest_lng) < 0.0001:
        logger.info("Origin and destination are very close, returning zero route")
        return {"distance_meters": 0, "distance_miles": 0.0, "duration_seconds": 0, "polyline": ""}

    result = gmaps.directions(origin=origin, destination=destination, mode="driving", units="metric")

    if not result:
        raise ValueError("Route not found")

    route = result[0]
    leg = route["legs"][0]

    distance_meters = leg["distance"]["value"]
    distance_miles = round(distance_meters * 0.000621371, 2)
    duration_seconds = leg["duration"]["value"]
    polyline = route.get("overview_polyline", {}).get("points")

    return {
        "distance_meters": distance_meters,
        "distance_miles": distance_miles,
        "duration_seconds": duration_seconds,
        "polyline": polyline,
    }


@app.get("/health")
def health_check():
    redis_ok = False
    if redis_client:
        try:
            redis_client.ping()
            redis_ok = True
        except Exception:
            pass
    return {
        "status": "success",
        "message": "Routing Service is running",
        "google_maps_configured": GOOGLE_MAPS_API_KEY is not None,
        "redis_connected": redis_ok,
    }


@app.post("/route/calculate", response_model=RouteResponse)
async def calculate_route(request: RouteRequest):
    """
    Calculate route distance and duration using Google Maps Directions API.
    Results are cached in Redis for ROUTE_CACHE_TTL seconds (default 1 hour).
    Google Maps calls run in a thread pool to avoid blocking the async event loop.
    """
    origin_str = request.origin.strip()
    destination_str = request.destination.strip()
    cache_key = get_cache_key(origin_str, destination_str)

    cached = _cache_get(cache_key)
    if cached:
        return RouteResponse(**cached)

    loop = asyncio.get_event_loop()

    try:
        try:
            o_lat, o_lng = map(float, origin_str.split(','))
            d_lat, d_lng = map(float, destination_str.split(','))
        except ValueError:
            # Non-coordinate strings (e.g. addresses) — pass through to gmaps directly
            if not gmaps:
                raise HTTPException(status_code=503, detail="Google Maps API not configured")

            def _address_route():
                result = gmaps.directions(
                    origin=origin_str, destination=destination_str, mode="driving", units="metric"
                )
                if not result:
                    raise ValueError("Route not found")
                route = result[0]
                leg = route["legs"][0]
                dm = leg["distance"]["value"]
                return {
                    "distance_meters": dm,
                    "distance_miles": round(dm * 0.000621371, 2),
                    "duration_seconds": leg["duration"]["value"],
                    "polyline": route.get("overview_polyline", {}).get("points"),
                }

            data = await loop.run_in_executor(route_executor, _address_route)
            _cache_set(cache_key, data)
            return RouteResponse(**data)

        data = await loop.run_in_executor(
            route_executor, partial(calculate_route_core, o_lat, o_lng, d_lat, d_lng)
        )
        _cache_set(cache_key, data)
        return RouteResponse(**data)

    except (ValueError, RuntimeError) as e:
        if "not configured" in str(e):
            raise HTTPException(status_code=503, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except googlemaps.exceptions.ApiError as e:
        logger.error(f"Google Maps API error for {origin_str} -> {destination_str}: {e}")
        raise HTTPException(status_code=502, detail=f"Google Maps API error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Route calculation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to calculate route")


def _optimize_core(origin: str, destination: str, waypoints: list) -> dict:
    """
    Optimized multi-stop route using Google Maps Directions with
    optimize_waypoints. Blocking — always call via run_in_executor.
    Google reorders the intermediate stops for the shortest total route and
    returns waypoint_order (indices into the original waypoints list).
    """
    if not gmaps:
        raise RuntimeError("Google Maps API not configured")
    if not waypoints:
        raise ValueError("waypoints required")

    result = gmaps.directions(
        origin=origin,
        destination=destination,
        waypoints=waypoints,
        optimize_waypoints=True,
        mode="driving",
        units="metric",
    )
    if not result:
        raise ValueError("Route not found")

    route = result[0]
    legs = route["legs"]
    distance_meters = sum(leg["distance"]["value"] for leg in legs)
    duration_seconds = sum(leg["duration"]["value"] for leg in legs)

    return {
        "distance_meters": distance_meters,
        "distance_miles": round(distance_meters * 0.000621371, 2),
        "duration_seconds": duration_seconds,
        "waypoint_order": route.get("waypoint_order", []),
        "polyline": route.get("overview_polyline", {}).get("points"),
    }


@app.post("/route/optimize", response_model=OptimizeResponse)
async def optimize_route(request: OptimizeRequest):
    """
    Optimized multi-stop route distance/duration for the T-1h discount freeze.
    Google reorders the supplied waypoints (rider pickups/dropoffs) to minimize
    total driving distance. Not cached — waypoint sets are per-trip and unique.
    """
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(
            route_executor,
            partial(
                _optimize_core,
                request.origin.strip(),
                request.destination.strip(),
                [w.strip() for w in request.waypoints],
            ),
        )
        return OptimizeResponse(**data)
    except (ValueError, RuntimeError) as e:
        if "not configured" in str(e):
            raise HTTPException(status_code=503, detail=str(e)) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    except googlemaps.exceptions.ApiError as e:
        logger.error(f"Google Maps API error optimizing route: {e}")
        raise HTTPException(status_code=502, detail=f"Google Maps API error: {e!s}") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Route optimization error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to optimize route") from e


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("ROUTING_SERVICE_PORT", "8002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
