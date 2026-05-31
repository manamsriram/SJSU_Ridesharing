#!/usr/bin/env bash
# scripts/generate-protos-python.sh
set -e

PROTO_DIR="proto"

# Create output directories
mkdir -p services/routing-service/src/generated
mkdir -p services/embedding-service/src/generated

# routing-service: needs routing.proto + common.proto
python -m grpc_tools.protoc \
  -I "$PROTO_DIR" \
  --python_out=services/routing-service/src/generated/ \
  --grpc_python_out=services/routing-service/src/generated/ \
  "$PROTO_DIR/common.proto" "$PROTO_DIR/routing.proto"

# embedding-service: needs embedding.proto only
python -m grpc_tools.protoc \
  -I "$PROTO_DIR" \
  --python_out=services/embedding-service/src/generated/ \
  --grpc_python_out=services/embedding-service/src/generated/ \
  "$PROTO_DIR/embedding.proto"

# Add __init__.py files
touch services/routing-service/src/generated/__init__.py
touch services/embedding-service/src/generated/__init__.py

echo "Python stubs generated"
