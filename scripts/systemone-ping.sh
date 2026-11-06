#!/usr/bin/env bash
# Hit local System One every 1 minute with rotating example payloads until Ctrl+C.

URL="${SYSTEMONE_URL:-http://localhost:11434/v1/systemone}"
INTERVAL_SEC="${INTERVAL_SEC:-60}"
MODEL="${SYSTEMONE_MODEL:-nimble-v3:9b}"

# Each entry: name|json-body (without model; model is injected)
EXAMPLES=(
  'greeting|{"state":"Hello World","questions":{"says_hello":{"type":"noul","instructions":"Does the state text contain a greeting?","criteria":{"true":"The state text contains a greeting.","false":"The state text does not contain a greeting."}}}}'

  'no_greeting|{"state":"The build failed on line 42.","questions":{"says_hello":{"type":"noul","instructions":"Does the state text contain a greeting?","criteria":{"true":"The state text contains a greeting.","false":"The state text does not contain a greeting."}}}}'

  'task_done|{"state":"User asked for a summary. I wrote three bullets and stopped.","questions":{"is_complete":{"type":"noul","instructions":"Has the assistant finished the user request?","criteria":{"true":"The request is finished.","false":"The request is still open."}}}}'

  'needs_tools|{"state":"Find every TODO in apps/api and list the file paths.","questions":{"needs_search":{"type":"noul","instructions":"Does this task require searching the codebase?","criteria":{"true":"Searching the codebase is required.","false":"No codebase search is needed."}}}}'

  'multi_q|{"state":"Please refactor auth and also fix the flaky e2e test.","questions":{"is_multi_part":{"type":"noul","instructions":"Does the state describe more than one distinct task?","criteria":{"true":"There are multiple tasks.","false":"There is a single task."}},"mentions_tests":{"type":"noul","instructions":"Does the state mention tests?","criteria":{"true":"Tests are mentioned.","false":"Tests are not mentioned."}}}}'

  'warmup|{"state":"warm-up","questions":{"ready":{"type":"noul","instructions":"Is this a warm-up request?","criteria":{"true":"It is a warm-up request.","false":"It is not."}}}}'
)

count=${#EXAMPLES[@]}
i=0

echo "Pinging $URL every ${INTERVAL_SEC}s with ${count} rotating examples (Ctrl+C to stop)"

while true; do
  entry="${EXAMPLES[$i]}"
  name="${entry%%|*}"
  body_without_model="${entry#*|}"
  payload=$(printf '%s' "$body_without_model" | sed "s/^{/{\"model\":\"$MODEL\",/")

  echo "---- $(date '+%Y-%m-%d %H:%M:%S') example=$((i + 1))/$count name=$name ----"
  curl -sS "$URL" \
    -H "Content-Type: application/json" \
    -d "$payload" || echo "request failed"
  echo

  i=$(( (i + 1) % count ))
  sleep "$INTERVAL_SEC"
done
