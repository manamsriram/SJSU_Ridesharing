from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import googlemaps
# import redis
import json
import hashlib
import os
import sys
import threading
import logging
from typing import Optional, Union
from dotenv import load_dotenv

# K8s manifest update - port fix (8002)
from app.secret_loader import load_mounted_secrets

# Add src/ to path so grpc_server can find the generated stubs
_SRC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

logger = logging.getLogger(__name__)

load_dotenv()
load_mounted_secrets()

app = FastAPI(title="Routing Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Google Maps client
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
if not GOOGLE_MAPS_API_KEY:
    print("⚠️ GOOGLE_MAPS_API_KEY not set - routing will fail")
    gmaps = None
else:
    gmaps = googlemaps.Client(key=GOOGLE_MAPS_API_KEY)

# Redis client disabled - Redis not configured
# Initialize Redis client
# in_kubernetes = os.getenv("KUBERNETES_SERVICE_HOST") is not None
# default_redis_url = "redis://redis:6379" if in_kubernetes else "redis://127.0.0.1:6379"
# REDIS_URL = os.getenv("REDIS_URL", default_redis_url)
# CACHE_TTL = int(os.getenv("ROUTE_CACHE_TTL", "3600"))  # 1 hour default
#
# try:
#     redis_client = redis.from_url(REDIS_URL, decode_responses=True)
#     redis_client.ping()
#     print(f"✅ Connected to Redis at {REDIS_URL}")
# except Exception as e:
#     print(f"⚠️ Redis connection failed: {e}")
#     redis_client = None

# Stub redis_client to None - caching disabled
redis_client = None
CACHE_TTL = 3600  # 1 hour default (kept for compatibility)

GRPC_PORT = int(os.getenv("GRPC_PORT", "9002"))


class RouteRequest(BaseModel):
    origin: str
    destination: str


class RouteResponse(BaseModel):
    distance_meters: int
    distance_miles: float
    duration_seconds: int
    polyline: Optional[str] = None


def get_cache_key(origin: str, destination: str) -> str:
    """Generate cache key from origin and destination"""
    key_str = f"route:{origin}:{destination}".lower()
    return hashlib.md5(key_str.encode()).hexdigest()


def calculate_route_core(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> dict:
    """
    Core route calculation using Google Maps Directions API.
    Accepts lat/lng floats and returns a dict with distance_meters, distance_miles,
    duration_seconds, and polyline. Raises ValueError / RuntimeError on failure.
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


@app.on_event("startup")
async def startup_grpc():
    from grpc_server import serve as serve_grpc

    grpc_thread = threading.Thread(
        target=lambda: serve_grpc(calculate_route_core, GRPC_PORT).wait_for_termination(),
        daemon=True,
    )
    grpc_thread.start()
    app.state.grpc_thread = grpc_thread


@app.get("/health")
def health_check():
    return {
        "status": "success",
        "message": "Routing Service is running",
        "google_maps_configured": GOOGLE_MAPS_API_KEY is not None,
        "redis_connected": False,  # Redis disabled
    }


@app.post("/route/calculate", response_model=RouteResponse)
async def calculate_route(request: RouteRequest):
    """
    Calculate route distance and duration using Google Maps Distance Matrix API
    Results are cached in Redis for 1 hour (caching currently disabled)
    """
    try:
        # Parse string coordinates from the HTTP request into lat/lng floats
        origin_str = request.origin.strip()
        destination_str = request.destination.strip()

        try:
            o_lat, o_lng = map(float, origin_str.split(','))
            d_lat, d_lng = map(float, destination_str.split(','))
        except ValueError:
            # Non-coordinate strings (e.g. addresses) — pass through as lat=0/lng=0 sentinel
            # and fall back to the raw string form via a direct gmaps call
            if not gmaps:
                raise HTTPException(status_code=503, detail="Google Maps API not configured")
            result = gmaps.directions(
                origin=origin_str, destination=destination_str, mode="driving", units="metric"
            )
            if not result:
                raise HTTPException(status_code=400, detail="Route not found")
            route = result[0]
            leg = route["legs"][0]
            distance_meters = leg["distance"]["value"]
            polyline = route.get("overview_polyline", {}).get("points")
            return RouteResponse(
                distance_meters=distance_meters,
                distance_miles=round(distance_meters * 0.000621371, 2),
                duration_seconds=leg["duration"]["value"],
                polyline=polyline,
            )

        data = calculate_route_core(o_lat, o_lng, d_lat, d_lng)
        return RouteResponse(**data)

    except (ValueError, RuntimeError) as e:
        if "not configured" in str(e):
            raise HTTPException(status_code=503, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except googlemaps.exceptions.ApiError as e:
        raise HTTPException(status_code=502, detail=f"Google Maps API error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Route calculation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to calculate route")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("ROUTING_SERVICE_PORT", "8002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
