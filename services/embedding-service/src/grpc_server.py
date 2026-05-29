# services/embedding-service/src/grpc_server.py
import sys
import os
import grpc
import json
import logging
from concurrent import futures

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logger = logging.getLogger(__name__)


def _build_server(match_fn, port: int) -> grpc.Server:
    """
    match_fn: callable(payload: dict) -> any JSON-serializable result
    """
    try:
        from generated import embedding_pb2, embedding_pb2_grpc
    except ImportError as e:
        raise ImportError(
            "Generated proto stubs not found. Run: bash scripts/generate-protos-python.sh"
        ) from e

    class EmbeddingServiceServicer(embedding_pb2_grpc.EmbeddingServiceServicer):
        def Match(self, request, context):
            try:
                payload = json.loads(request.payload_json)
                result = match_fn(payload)
                return embedding_pb2.MatchResponse(
                    result_json=json.dumps(result)
                )
            except json.JSONDecodeError as e:
                logger.error(f"EmbeddingService.Match: invalid JSON payload: {e}")
                context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                context.set_details(f"Invalid JSON payload: {e}")
                return embedding_pb2.MatchResponse(result_json="[]")
            except Exception as e:
                logger.error(f"EmbeddingService.Match error: {e}", exc_info=True)
                context.set_code(grpc.StatusCode.INTERNAL)
                context.set_details(str(e))
                return embedding_pb2.MatchResponse(result_json="[]")

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ("grpc.max_send_message_length", 16 * 1024 * 1024),
            ("grpc.max_receive_message_length", 16 * 1024 * 1024),
        ],
    )
    embedding_pb2_grpc.add_EmbeddingServiceServicer_to_server(EmbeddingServiceServicer(), server)
    server.add_insecure_port(f"[::]:{port}")
    return server


def serve(match_fn, port: int = 4010):
    server = _build_server(match_fn, port)
    server.start()
    logger.info(f"[embedding-service] gRPC server started on port {port}")
    return server
