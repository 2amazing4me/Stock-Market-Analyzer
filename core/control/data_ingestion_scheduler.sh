#!/bin/bash

set -e  # stop on first error

# Resolve the project root whether invoked from core/control or a root-level symlink.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "core" ]; then
	PROJECT_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
else
	PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
fi

LOG_FILE="$PROJECT_ROOT/logs/core/data_ingestion/pipeline.log"

# Ensure the log directory exists before writing to it.
mkdir -p "$(dirname "$LOG_FILE")"

sleep 10  # wait for the system to stabilize after startup

echo "==== Run started at $(date) ====" >> "$LOG_FILE"

# Run Python modules from project root so package imports resolve reliably.
pushd "$PROJECT_ROOT" > /dev/null

# Step 1: update rate limits for today
echo "Updating rate limits..." >> "$LOG_FILE"
echo 800 > "$PROJECT_ROOT/core/control/data_layer/rate_limits_today.txt"

# Step 2: run market data ingestion script
echo "Running market data ingestion script..." >> "$LOG_FILE"
stdbuf -oL -eL python3 -u -m core.data.market_data_ingestor.market_data_ingestor >> "$LOG_FILE" 2>&1

# Step 3: run parquet file manager script
echo "Running parquet file manager script..." >> "$LOG_FILE"
stdbuf -oL -eL python3 -u -m core.data.market_data_ingestor.parquet_file_manager >> "$LOG_FILE" 2>&1
popd > /dev/null

echo "==== Run finished at $(date) ====" >> "$LOG_FILE"
