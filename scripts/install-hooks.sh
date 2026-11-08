#!/usr/bin/env bash
# Installs the pre-commit hook that runs scripts/check_private.py on the staged files.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/pre-commit"
printf '#!/usr/bin/env bash\nexec python3 "$(git rev-parse --show-toplevel)/scripts/check_private.py"\n' > "$hook"
chmod +x "$hook"
echo "installed $hook"
