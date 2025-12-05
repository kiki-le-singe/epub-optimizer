FROM node:23-slim

# Install Java and build tools
RUN apt-get update && apt-get install -y \
    openjdk-17-jre-headless \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@9.5.0

WORKDIR /app

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY . .

# Build the project
RUN pnpm build

# Download and setup EPUBCheck, then clean up
RUN wget https://github.com/w3c/epubcheck/releases/download/v5.3.0/epubcheck-5.3.0.zip \
    && unzip epubcheck-5.3.0.zip \
    && mv epubcheck-5.3.0 epubcheck \
    && rm epubcheck-5.3.0.zip \
    && apt-get remove -y wget unzip \
    && apt-get autoremove -y \
    && apt-get clean

# Create a volume mount point for EPUB files
VOLUME ["/epub-files"]

# Set the entrypoint to your pipeline script
ENTRYPOINT ["node", "dist/src/pipeline.js"]
