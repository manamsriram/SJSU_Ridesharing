#!/usr/bin/env bash
# scripts/generate-protos.sh
set -e

PROTO_DIR="proto"
TS_OUT="shared/generated"
PROTOC="./node_modules/.bin/grpc_tools_node_protoc"
PLUGIN="./node_modules/.bin/protoc-gen-ts_proto"

mkdir -p "$TS_OUT"

$PROTOC \
  --plugin="protoc-gen-ts_proto=$PLUGIN" \
  --ts_proto_out="$TS_OUT" \
  --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,useOptionals=messages \
  --proto_path="$PROTO_DIR" \
  "$PROTO_DIR"/*.proto

echo "TypeScript stubs generated in $TS_OUT"
