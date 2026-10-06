#!/bin/bash
# merge ticks -> run scalp engine -> push (retrying on races) -> notify + deploy
git config user.name "gold-bot"
git config user.email "gold-bot@users.noreply.github.com"
for i in 1 2 3 4 5 6; do
  git fetch -q origin main && git reset -q --hard origin/main
  python collect.py merge && python scalp.py
  git add candles.json scalp.json signals.json
  if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
  git commit -qm "Scalp update"
  if git push -q origin HEAD:main; then
    python scalp.py notify
    gh workflow run deploy.yml --ref main >/dev/null 2>&1 || echo "deploy dispatch failed"
    exit 0
  fi
  sleep $((RANDOM % 5 + 2))
done
echo "push failed after retries"
