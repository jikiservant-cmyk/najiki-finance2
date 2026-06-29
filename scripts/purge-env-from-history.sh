#!/bin/bash
# ============================================================
# CRITICAL: Your .env was committed to git history.
# Real credentials (Supabase password, LivePay keys, etc.)
# are visible in at least 3 commits on GitHub right now.
#
# Step 1: Rotate ALL secrets first (do this before running this script)
# Step 2: Run this script to purge the .env from history
# Step 3: Force-push the cleaned history
# ============================================================

set -e

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  BEFORE running this script, you MUST rotate:           ║"
echo "║  • Supabase database password                           ║"
echo "║  • Supabase service role key                            ║"
echo "║  • LivePay API key + secret                             ║"
echo "║  • DASHBOARD_API_KEY                                    ║"
echo "║  • CRON_SECRET                                          ║"
echo "║  • NEXTAUTH_SECRET                                      ║"
echo "║                                                          ║"
echo "║  Rotating keys: Supabase → Settings → Database          ║"
echo "║  → Reset database password                              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
read -p "Have you rotated ALL the above secrets? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborting. Rotate your secrets first."
  exit 1
fi

echo ""
echo "Purging .env from git history using git-filter-repo..."
echo "(If git-filter-repo is not installed: pip install git-filter-repo)"
echo ""

# Remove .env from every commit in history
git filter-repo --path .env --invert-paths --force

echo ""
echo "Done. Now force-push the cleaned history:"
echo ""
echo "  git remote add origin <your-repo-url>   # if remote was removed"
echo "  git push origin --force --all"
echo "  git push origin --force --tags"
echo ""
echo "⚠️  Anyone who has cloned this repo should re-clone after the force push."
echo "⚠️  GitHub's cache may still serve the old content for a few minutes."
echo "    Submit a 'cached data removal' request at:"
echo "    https://support.github.com/contact"
echo ""
echo "After force-push, verify the .env is gone:"
echo "  git log --all --oneline -- .env   # should return empty"
