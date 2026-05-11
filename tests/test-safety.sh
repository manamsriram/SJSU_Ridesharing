#!/bin/bash
# ============================================================
# LessGo Safety Service Simulation (port 8005)
#
# Simulates three scenarios end-to-end:
#   1. Normal ride  — on route, legal speed → no anomalies
#   2. Route deviation — driver goes off route
#   3. Speed anomaly  — driver sustains speed > 80.5 mph
#                       (70 mph limit + 15% tolerance)
#
# Requires: safety-service running on port 8005
#   cd services/safety-service && npm run dev
# ============================================================

set -e
BASE="http://localhost:8005"

# Generate the planned route polyline from the exact coordinates used in the
# normal-ride test, so those updates are guaranteed to be on-route.
SAFETY_SVC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../services/safety-service" && pwd)"
PLANNED_ROUTE=$(cd "$SAFETY_SVC_DIR" && node -e "
  const p = require('@mapbox/polyline');
  const pts = [[37.3352,-121.8811],[37.3353,-121.8800],[37.3354,-121.8790],[37.3355,-121.8780]];
  process.stdout.write(p.encode(pts));
" 2>/dev/null)

if [ -z "$PLANNED_ROUTE" ]; then
    echo "❌ Could not generate polyline — is @mapbox/polyline installed in services/safety-service?"
    exit 1
fi

# UUIDs for each scenario (pre-generated so they don't need a DB trip)
RIDE_NORMAL="aaaaaaaa-0000-4000-a000-000000000001"
RIDE_DEVIATE="bbbbbbbb-0000-4000-b000-000000000002"
RIDE_SPEED="cccccccc-0000-4000-8000-000000000003"

# ── helpers ────────────────────────────────────────────────

check_health() {
    response=$(curl -s -w "\n%{http_code}" "$BASE/health")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ]; then
        message=$(echo "$body" | jq -r '.message // .status')
        echo "   ✅ Health: $message"
    else
        echo "   ❌ Safety service not reachable on $BASE"
        echo "      Start it with: cd services/safety-service && npm run dev"
        exit 1
    fi
}

start_ride() {
    local ride_id=$1
    response=$(curl -s -w "\n%{http_code}" -X POST "$BASE/rides/$ride_id/start" \
        -H "Content-Type: application/json" \
        -d "{\"planned_route\":\"$PLANNED_ROUTE\"}")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        echo "   ✅ Monitoring started for ride $ride_id"
    else
        echo "   ❌ Failed to start ride: $body"
        exit 1
    fi
}

send_location() {
    local ride_id=$1
    local lat=$2
    local lng=$3
    local speed=$4
    local label=$5

    response=$(curl -s -w "\n%{http_code}" -X POST "$BASE/rides/$ride_id/location" \
        -H "Content-Type: application/json" \
        -d "{\"coordinates\":{\"lat\":$lat,\"lng\":$lng},\"speed\":$speed}")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    anomalies=$(echo "$body" | jq -r '.data.anomalies // [] | join(", ")' 2>/dev/null || echo "parse error")
    count=$(echo "$body" | jq -r '.data.anomalies_detected // 0' 2>/dev/null || echo "?")

    if [ "$count" = "0" ]; then
        echo "   ✅ $label → no anomalies"
    else
        echo "   ⚠️  $label → anomalies detected: [$anomalies]"
    fi
}

end_ride() {
    local ride_id=$1
    curl -s -X POST "$BASE/rides/$ride_id/end" > /dev/null
    echo "   🏁 Ride $ride_id ended"
}

fetch_anomalies() {
    local ride_id=$1
    response=$(curl -s "$BASE/rides/$ride_id/anomalies")
    count=$(echo "$response" | jq '.data.anomalies | length' 2>/dev/null || echo "?")
    echo "   📋 Total anomalies logged: $count"

    if [ "$count" != "0" ] && [ "$count" != "?" ]; then
        echo "$response" | jq -r '.data.anomalies[] | "      • \(.type) at \(.detected_at) — acknowledged: \(.acknowledged)"' 2>/dev/null || true

        # Acknowledge the first unacknowledged anomaly
        first_id=$(echo "$response" | jq -r '[.data.anomalies[] | select(.acknowledged == false)][0].anomaly_id' 2>/dev/null || echo "null")
        if [ "$first_id" != "null" ] && [ -n "$first_id" ]; then
            ack_response=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/anomalies/$first_id/acknowledge")
            ack_code=$(echo "$ack_response" | tail -n1)
            if [ "$ack_code" = "200" ]; then
                echo "   ✅ Acknowledged anomaly $first_id"
            else
                echo "   ℹ️  Could not acknowledge $first_id (may not be in DB — no Supabase connection)"
            fi
        fi
    fi
}

# ── main ───────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Safety Service Simulation ($BASE)"
echo "========================================"
echo ""

# 0. Health check
echo "0. Health Check"
check_health
echo ""

# ----------------------------------------------------------
# Scenario 1: Normal ride — on route, legal speed
# ----------------------------------------------------------
echo "1. Normal Ride (on route, speed 30 mph)"
start_ride "$RIDE_NORMAL"

# Points that lie along the planned route near SJSU
send_location "$RIDE_NORMAL" 37.3352 -121.8811 30 "update 1 (on route, 30 mph)"
send_location "$RIDE_NORMAL" 37.3353 -121.8800 35 "update 2 (on route, 35 mph)"
send_location "$RIDE_NORMAL" 37.3354 -121.8790 28 "update 3 (on route, 28 mph)"

end_ride "$RIDE_NORMAL"
fetch_anomalies "$RIDE_NORMAL"
echo ""

# ----------------------------------------------------------
# Scenario 2: Route deviation — driver goes off course
# ----------------------------------------------------------
echo "2. Route Deviation (driver goes off course)"
start_ride "$RIDE_DEVIATE"

send_location "$RIDE_DEVIATE" 37.3352 -121.8811 30 "update 1 (on route, 30 mph)"

# Deviate to Palo Alto (~30 km away from the planned route)
send_location "$RIDE_DEVIATE" 37.4419 -122.1430 30 "update 2 (off route — Palo Alto)"
send_location "$RIDE_DEVIATE" 37.4500 -122.1500 25 "update 3 (still off route)"

end_ride "$RIDE_DEVIATE"
fetch_anomalies "$RIDE_DEVIATE"
echo ""

# ----------------------------------------------------------
# Scenario 3: Speed anomaly — sustained 90 mph
#
# Threshold: 70 mph limit × 1.15 tolerance = 80.5 mph max
# Window: 10s / 5s poll = 2 consecutive violations needed
# We send 3 updates to be safe.
# ----------------------------------------------------------
echo "3. Speed Anomaly (sustained 90 mph — limit is 70 mph + 15% = 80.5 mph)"
start_ride "$RIDE_SPEED"

send_location "$RIDE_SPEED" 37.3352 -121.8811 30  "update 1 (on route, 30 mph — normal)"
send_location "$RIDE_SPEED" 37.3353 -121.8800 90  "update 2 (90 mph — violation 1)"
send_location "$RIDE_SPEED" 37.3354 -121.8790 95  "update 3 (95 mph — violation 2, should alert)"
send_location "$RIDE_SPEED" 37.3355 -121.8780 40  "update 4 (40 mph — slowing down, counter resets)"

end_ride "$RIDE_SPEED"
fetch_anomalies "$RIDE_SPEED"
echo ""

echo "========================================"
echo "  Simulation complete"
echo ""
echo "  Note: anomaly DB logging and acknowledgement"
echo "  require DATABASE_URL in .env pointing to Supabase."
echo "  Detection and in-response anomaly reporting works"
echo "  without a DB connection."
echo "========================================"
echo ""
