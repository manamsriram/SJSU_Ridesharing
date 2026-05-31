import sys
import os
import grpc
import logging
from concurrent import futures

# Add generated stubs directory to path so bare imports (routing_pb2, common_pb2) resolve
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated"))

logger = logging.getLogger(__name__)


def _build_server(route_calculator_fn, port: int) -> grpc.Server:
    """
    route_calculator_fn: callable(origin_lat, origin_lng, dest_lat, dest_lng) -> dict
      Returns dict with keys: distance_meters, distance_miles, duration_seconds, polyline
    """
    try:
        from generated import routing_pb2, routing_pb2_grpc
    except ImportError as e:
        raise ImportError(
            "Generated proto stubs not found. Run: bash scripts/generate-protos-python.sh"
        ) from e

    class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
        def CalculateRoute(self, request, context):
            try:
                result = route_calculator_fn(
                    origin_lat=request.origin.lat,
                    origin_lng=request.origin.lng,
                    dest_lat=request.destination.lat,
                    dest_lng=request.destination.lng,
                )
                return routing_pb2.RouteCalculateResponse(
                    distance_meters=float(result.get("distance_meters", 0)),
                    distance_miles=float(result.get("distance_miles", 0)),
                    duration_seconds=float(result.get("duration_seconds", 0)),
                    polyline=str(result.get("polyline", "")),
                )
            except Exception as e:
                logger.error(f"RoutingService.CalculateRoute error: {e}", exc_info=True)
                context.set_code(grpc.StatusCode.INTERNAL)
                context.set_details(str(e))
                return routing_pb2.RouteCalculateResponse()

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ("grpc.max_send_message_length", 4 * 1024 * 1024),
            ("grpc.max_receive_message_length", 4 * 1024 * 1024),
        ],
    )
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)
    server.add_insecure_port(f"[::]:{port}")
    return server


def serve(route_calculator_fn, port: int = 9002) -> grpc.Server:
    server = _build_server(route_calculator_fn, port)
    server.start()
    logger.info(f"[routing-service] gRPC server started on port {port}")
    return server
