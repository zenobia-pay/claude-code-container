# Use Alpine-based Node for more reliable package downloads
FROM node:22-alpine

# Install git and curl via apk (Alpine package manager)
RUN apk add --no-cache git curl bash

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory
RUN mkdir -p /workspace
WORKDIR /workspace

# Copy the server
COPY server.js /app/server.js

EXPOSE 4000

CMD ["node", "/app/server.js"]
