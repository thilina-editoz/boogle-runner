# ─────────────────────────────────────────────────────────
#  Boogle Pipeline Runner — container image (Stage 11 Phase 2)
#
#  The runner is a long-running polling worker (worker/index.js).
#  It holds ONLY its per-customer runner token + BYOK keys + the
#  dashboard URL — never the Supabase service-role key. All DB
#  access is brokered by the dashboard's /api/internal/* routes.
#  See PLAN-RUNNER.md.
#
#  System ffmpeg (apt): johnvansickle's `ffmpeg-static` build ships WITHOUT
#  the `drawtext` filter, so full-screen text "card" segments can't render on
#  it. Debian's ffmpeg has drawtext + libass + fontconfig. We install it +
#  fontconfig + DejaVu and point the runner at it via FFMPEG_PATH; ffmpeg-static
#  stays the fallback for non-container/dev hosts (its Windows build has drawtext).
#  fonts-dejavu-core + fontconfig also let libass resolve "DejaVu Sans" by name
#  (the bundled edit-brain/fonts/ remains a belt-and-suspenders fallback).
#
#  All config is injected as env vars at runtime by the host —
#  nothing else is baked into the image. Build for linux/amd64 to match
#  most cloud hosts:
#    docker build --platform=linux/amd64 -t boogle-runner .
# ─────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# System ffmpeg (with drawtext/libass) + fonts. Early layer so it caches across
# code changes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg fontconfig \
       fonts-dejavu-core fonts-liberation2 fonts-roboto-unhinted fonts-firacode \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/usr/bin/ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "worker/index.js"]
