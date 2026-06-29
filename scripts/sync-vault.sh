#!/bin/bash
# sync-vault.sh
# Sync Obsidian vault → Astro src/content/
# Usage: ./scripts/sync-vault.sh [--dry-run]
#
# Copies articles from the iCloud Hermes vault, transforms wikilinks, and
# flattens image references. Skips non-publishable content (Job Applier,
# Projects, Daily Revision, Company Prep, Resume, etc.)

set -e

DRY_RUN=false
if [ "$1" == "--dry-run" ]; then
  DRY_RUN=true
fi

VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Hermes"
SRC="$(dirname "$0")/../src/content"

SD_SRC="$VAULT/System Design"
CIP_SRC="$VAULT/Coding Interview Prep"
GLOSSARY_SRC="$VAULT/Glossary.md"

SD_DST="$SRC/system-design"
CIP_DST="$SRC/coding-interview"
GLOSSARY_DST="$SRC/glossary"

# Files/dirs to skip
SKIP_DIRS=("Weakness Vault" "Daily Revision")

log() {
  echo "[$(date +%H:%M:%S)] $1"
}

# 1. Process System Design articles
log "Syncing System Design → $SD_DST"
COUNT_SD=0
if [ -d "$SD_SRC" ]; then
  while IFS= read -r f; do
    filename=$(basename "$f" .md)
    # Skip files in excluded subdirs
    skip=false
    for skipdir in "${SKIP_DIRS[@]}"; do
      if [[ "$f" == *"/$skipdir/"* ]]; then
        skip=true
        break
      fi
    done
    [ "$skip" = true ] && continue

    # Slugify: URL-safe version
    slug=$(echo "$filename" | tr '[:upper:]' '[:lower:]' | sed 's/&/and/g' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
    dest="$SD_DST/$slug.md"

    if [ "$DRY_RUN" = true ]; then
      log "  DRY: $filename → system-design/$slug.md"
    else
      cp "$f" "$dest"
      COUNT_SD=$((COUNT_SD + 1))
    fi
  done < <(find "$SD_SRC" -maxdepth 1 -name "*.md" -type f)
fi
log "  Synced $COUNT_SD System Design articles"

# 2. Process Coding Interview Prep articles
log "Syncing Coding Interview Prep → $CIP_DST"
COUNT_CIP=0
if [ -d "$CIP_SRC" ]; then
  while IFS= read -r f; do
    filename=$(basename "$f" .md)
    slug=$(echo "$filename" | tr '[:upper:]' '[:lower:]' | sed 's/&/and/g' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
    dest="$CIP_DST/$slug.md"

    if [ "$DRY_RUN" = true ]; then
      log "  DRY: $filename → coding-interview/$slug.md"
    else
      cp "$f" "$dest"
      COUNT_CIP=$((COUNT_CIP + 1))
    fi
  done < <(find "$CIP_SRC" -maxdepth 1 -name "*.md" -type f)
fi
log "  Synced $COUNT_CIP Coding Interview Prep articles"

# 3. Process Glossary
log "Syncing Glossary → $GLOSSARY_DST"
if [ -f "$GLOSSARY_SRC" ]; then
  if [ "$DRY_RUN" = true ]; then
    log "  DRY: Glossary.md → glossary/Glossary.md"
  else
    cp "$GLOSSARY_SRC" "$GLOSSARY_DST/Glossary.md"
    log "  Synced Glossary"
  fi
fi

# 4. Transform wikilinks: [[Note Name]] → [Note Name](/path/to/note/)
# Only in synced files, not in vault (vault uses Obsidian wikilinks natively)
log "Transforming wikilinks in synced files"
if [ "$DRY_RUN" = true ]; then
  log "  DRY: would transform [[Note Name]] → links"
else
  # Build a slug index for wikilink resolution
  declare -A SLUG_INDEX
  for f in "$SD_DST"/*.md "$CIP_DST"/*.md "$GLOSSARY_DST"/*.md; do
    [ -f "$f" ] || continue
    slug=$(basename "$f" .md)
    # Convert slug back to readable title
    title=$(echo "$slug" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2))}1')
    SLUG_INDEX["$title"]="$slug"
    # Also index by full filename (without extension)
    SLUG_INDEX["$slug"]="$slug"
  done

  # Transform wikilinks in each file
  for f in "$SD_DST"/*.md "$CIP_DST"/*.md "$GLOSSARY_DST"/*.md; do
    [ -f "$f" ] || continue
    # Use perl for in-place multi-pattern replace
    perl -i -pe 's/\[\[([^\]]+)\]\]/[[REPL:$1]]/g' "$f"
  done

  # Resolve [[REPL:Title]] → markdown link by looking up in SLUG_INDEX
  for f in "$SD_DST"/*.md "$CIP_DST"/*.md "$GLOSSARY_DST"/*.md; do
    [ -f "$f" ] || continue
    # Determine category prefix from file location
    if [[ "$f" == *"/system-design/"* ]]; then prefix="/system-design"
    elif [[ "$f" == *"/coding-interview/"* ]]; then prefix="/coding-interview"
    elif [[ "$f" == *"/glossary/"* ]]; then prefix="/glossary"
    fi

    # Process each [[REPL:Title]]
    perl -i -pe "
      s/\[\[REPL:([^\]]+)\]\]/\\\$1/g;
    " "$f"

    # More robust: use Python to resolve all wikilinks against SLUG_INDEX
    python3 -c "
import re, os, sys
slug_index = $(declare -p SLUG_INDEX | sed -e 's/^declare -A //')
filepath = '$f'
with open(filepath, 'r') as fp:
    content = fp.read()

def resolve(match):
    target = match.group(1).strip()
    # Strip alias if present: 'Note Name|display text'
    if '|' in target:
        target, display = target.split('|', 1)
    else:
        display = target
    # Try exact match
    if target in slug_index:
        slug = slug_index[target]
        if '/system-design/' in '$f':
            return f'[{display}](/system-design/{slug}/)'
        elif '/coding-interview/' in '$f':
            return f'[{display}](/coding-interview/{slug}/)'
        elif '/glossary/' in '$f':
            return f'[{display}](/glossary/)'
    # Try slugified
    slug = re.sub(r'[^a-z0-9]+', '-', target.lower()).strip('-')
    if slug in slug_index:
        if '/system-design/' in '$f':
            return f'[{display}](/system-design/{slug_index[slug]}/)'
        elif '/coding-interview/' in '$f':
            return f'[{display}](/coding-interview/{slug_index[slug]}/)'
        elif '/glossary/' in '$f':
            return f'[{display}](/glossary/)'
    # Unresolved: keep as plain text reference
    return f'[{display}](#){{.wikilink-broken}}'

# Match [[anything]] that doesn't start with REPL:
new_content = re.sub(r'\[\[([^\]]+)\]\]', resolve, content)
# Also handle any leftover [[REPL:...]] markers by removing the prefix
new_content = re.sub(r'\[\[REPL:([^\]]+)\]\]', r'[[\1]]', new_content)
new_content = re.sub(r'\[\[([^\]]+)\]\]', resolve, new_content)

with open(filepath, 'w') as fp:
    fp.write(new_content)
"
  done

  log "  Wikilinks transformed"
fi

# 5. Summary
TOTAL=$((COUNT_SD + COUNT_CIP + 1))
log "✅ Sync complete. $TOTAL articles ready for build."
echo ""
echo "System Design: $COUNT_SD articles"
echo "Coding Interview Prep: $COUNT_CIP articles"
echo "Glossary: 1 article"
