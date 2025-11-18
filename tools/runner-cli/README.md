# Runner Service CLI Tool

A small Go utility for managing and monitoring the runner-service microservice.

## Building

```bash
cd tools/runner-cli
go build -o runner-cli main.go
```

Or install globally:
```bash
go install ./tools/runner-cli
```

## Usage

### Check Service Health
```bash
./runner-cli -health
# or just
./runner-cli
```

### Show Detailed Metrics
```bash
./runner-cli -metrics
```

### Watch Health Status
```bash
./runner-cli -watch
# Custom interval
./runner-cli -watch -interval 10s
```

### Clean Up Containers
```bash
./runner-cli -cleanup
# Custom prefix
./runner-cli -cleanup -prefix judge-python-worker
```

### Custom Service URL
```bash
./runner-cli -health -url http://localhost:4001
```

## Examples

```bash
# Quick health check
./runner-cli

# Monitor service every 5 seconds
./runner-cli -watch

# Clean up all runner containers
./runner-cli -cleanup

# Check remote service
./runner-cli -health -url http://production:4001
```

