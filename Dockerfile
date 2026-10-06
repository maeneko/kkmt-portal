# 1) фронтенд: Vite собирает статику в dist/public
FROM node:22-alpine AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY web ./web
RUN npm run build

# 2) бэкенд: один статический бинарник
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
RUN CGO_ENABLED=0 go build -o /kkmt ./server

# 3) итоговый образ: бинарник + собранный фронт
FROM gcr.io/distroless/static
ENV PUBLIC_DIR=/public
ENV UPLOAD_DIR=/data/uploads
COPY --from=server /kkmt /kkmt
COPY --from=web /app/dist/public /public
EXPOSE 3000
ENTRYPOINT ["/kkmt"]
