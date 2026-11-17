# 1. Record: a local proxy forwards every request unchanged and writes one record per model call.
npx prefixlens record --provider anthropic -o run.trace.jsonl     # or --provider openai

# 2. Point your agent at it and run a task as usual, in any language.
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787                   # openai: OPENAI_BASE_URL=http://127.0.0.1:8787/v1

# 3. Read it, or gate on it.
npx prefixlens report run.trace.jsonl --html    # every call: tokens read, written and lost, and the cause of each miss
npx prefixlens check run.trace.jsonl            # exits 1 when your harness broke its own cache
