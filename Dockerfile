# ─────────────────────────────────────────────────────────
#  Boogle Pipeline Runner — container image (Stage 11 Phase 2)
#
#  The runner is a long-running polling worker (worker/index.js).
#  It holds ONLY its per-customer runner token + BYOK keys + the
#  dashboard URL — never the Supabase service-role key. All DB
#  access is brokered by the dashboard's /api/internal/* routes.
#  See PLAN-RUNNER.md.
#
#  No system packages: ffmpeg-static's install script downloads the
#  platform-correct ffmpeg binary into node_modules during npm ci.
#  (Host node_modules is .dockerignore'd so the Linux binary is
#  fetched fresh, not the Windows ffmpeg.exe.)
#
#  All config is injected as env vars at runtime by the host —
#  nothing is baked into the image. Build for linux/amd64 to match
#  most cloud hosts:
#    docker build --platform=linux/amd64 -t boogle-runner .
# ─────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "worker/index.js"]
