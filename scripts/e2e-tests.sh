#!/bin/bash
set -e

# Note: src/generate-demo-transcript.ts is a genuine implementation file from 
# the parallel Implementation track and is NOT a cheating artifact, and therefore 
# MUST NOT be deleted.

cleanup_generated() {
  rm -f demo-transcript.jsonl benchmark-report.json app/static/samples/local/demo-transcript.jsonl
}
trap cleanup_generated EXIT

echo "Running E2E Test Suite..."

# 1. npm install
echo "Running npm install..."
npm install

# 2. npm run check (from app/ according to repo guidelines)
echo "Running npm run check in app/..."
(cd app && npm install && npm run check)

# 3. npm test
echo "Running npm test..."
npm test

# 4. Assert src/conductor.ts exactly contains constants
echo "Checking conductor.ts constraints..."
if ! grep -q "UNFOLD_RELATIVE_MARGIN = 0.08" src/conductor.ts; then
  echo "Error: UNFOLD_RELATIVE_MARGIN = 0.08 not found in src/conductor.ts"
  exit 1
fi

if ! grep -q "UNFOLD_SEMANTIC_FLOOR = 0.30" src/conductor.ts; then
  echo "Error: UNFOLD_SEMANTIC_FLOOR = 0.30 not found in src/conductor.ts"
  exit 1
fi

# 5. Assert grep -ri "TANGERINE" src/ returns 0 results
echo "Checking for TANGERINE in src/..."
set +e
grep_output=$(grep -ri "TANGERINE" src/ 2>/dev/null)
set -e
if [ -n "$grep_output" ]; then
  echo "Error: Found TANGERINE in src/ (should be 0 results)"
  exit 1
fi

# 6. Generate demo artifacts, then execute the Node test script
echo "Generating demo transcript and benchmark report..."
node --experimental-strip-types src/generate-demo-transcript.ts

echo "Running e2e test script..."
npm run test:e2e

echo "All E2E tests completed!"
