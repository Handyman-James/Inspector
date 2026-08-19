# Starts from Playwright's own official image, which already has Chromium and
# every system-level library it needs to run headlessly, fully pre-installed.
# This specifically avoids the problem hit on Render's standard Node build
# environment: playwright install --with-deps needs root access to run apt-get,
# which that environment doesn't grant. Starting from an image that already has
# everything baked in sidesteps that entirely - no apt-get step needed at all.
#
# The version tag here must match the "playwright" version pinned in
# package.json exactly - a mismatch between the npm package and the browser
# binaries baked into this image is a common, confusing source of failures.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
