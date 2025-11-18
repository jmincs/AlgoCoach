package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const defaultServiceURL = "http://127.0.0.1:4001"

type healthResponse struct {
	Status string `json:"status"`
	Image  string `json:"image"`
	PoolSize int `json:"poolSize"`
	ActiveWorkers int `json:"activeWorkers"`
	QueueLength int `json:"queueLength"`
	TotalRuns int `json:"totalRuns"`
	AvgRunMs float64 `json:"avgRunMs"`
	AvgQueueWaitMs float64 `json:"avgQueueWaitMs"`
}

type metricsResponse struct {
	UptimeSeconds float64 `json:"uptimeSeconds"`
	Memory struct {
		RSS int64 `json:"rss"`
		HeapTotal int64 `json:"heapTotal"`
		HeapUsed int64 `json:"heapUsed"`
	} `json:"memory"`
	Stats struct {
		PoolSize int `json:"poolSize"`
		ActiveWorkers int `json:"activeWorkers"`
		QueueLength int `json:"queueLength"`
		TotalRuns int `json:"totalRuns"`
		AvgRunMs float64 `json:"avgRunMs"`
		AvgQueueWaitMs float64 `json:"avgQueueWaitMs"`
	} `json:"stats"`
}

func checkHealth(serviceURL string) error {
	resp, err := http.Get(serviceURL + "/healthz")
	if err != nil {
		return fmt.Errorf("failed to connect: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("service returned status %d", resp.StatusCode)
	}

	var health healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return fmt.Errorf("failed to parse response: %v", err)
	}

	fmt.Println("✅ Runner Service Health Check")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Printf("Status:        %s\n", health.Status)
	fmt.Printf("Image:         %s\n", health.Image)
	fmt.Printf("Pool Size:     %d workers\n", health.PoolSize)
	fmt.Printf("Active:        %d workers\n", health.ActiveWorkers)
	fmt.Printf("Queue Length:  %d jobs\n", health.QueueLength)
	fmt.Printf("Total Runs:    %d\n", health.TotalRuns)
	if health.TotalRuns > 0 {
		fmt.Printf("Avg Run Time:  %.2f ms\n", health.AvgRunMs)
		fmt.Printf("Avg Wait Time: %.2f ms\n", health.AvgQueueWaitMs)
	}
	return nil
}

func showMetrics(serviceURL string) error {
	resp, err := http.Get(serviceURL + "/metrics")
	if err != nil {
		return fmt.Errorf("failed to connect: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %v", err)
	}

	var metrics metricsResponse
	if err := json.Unmarshal(body, &metrics); err != nil {
		return fmt.Errorf("failed to parse response: %v", err)
	}

	fmt.Println("📊 Runner Service Metrics")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Printf("Uptime:        %.1f seconds (%.1f hours)\n", 
		metrics.UptimeSeconds, metrics.UptimeSeconds/3600)
	fmt.Printf("Memory RSS:    %.2f MB\n", float64(metrics.Memory.RSS)/1024/1024)
	fmt.Printf("Heap Total:    %.2f MB\n", float64(metrics.Memory.HeapTotal)/1024/1024)
	fmt.Printf("Heap Used:     %.2f MB\n", float64(metrics.Memory.HeapUsed)/1024/1024)
	fmt.Println()
	fmt.Println("Pool Stats:")
	fmt.Printf("  Pool Size:     %d\n", metrics.Stats.PoolSize)
	fmt.Printf("  Active:        %d\n", metrics.Stats.ActiveWorkers)
	fmt.Printf("  Queue Length:  %d\n", metrics.Stats.QueueLength)
	fmt.Printf("  Total Runs:    %d\n", metrics.Stats.TotalRuns)
	if metrics.Stats.TotalRuns > 0 {
		fmt.Printf("  Avg Run Time:  %.2f ms\n", metrics.Stats.AvgRunMs)
		fmt.Printf("  Avg Wait:     %.2f ms\n", metrics.Stats.AvgQueueWaitMs)
	}
	return nil
}

func cleanupContainers(prefix string) error {
	cmd := exec.Command("docker", "ps", "-a", "--filter", fmt.Sprintf("name=%s", prefix), "--format", "{{.Names}}")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to list containers: %v", err)
	}

	containers := strings.Fields(string(output))
	if len(containers) == 0 {
		fmt.Printf("No containers found with prefix '%s'\n", prefix)
		return nil
	}

	fmt.Printf("Found %d container(s) to remove:\n", len(containers))
	for _, name := range containers {
		fmt.Printf("  - %s\n", name)
	}

	fmt.Print("\nRemove these containers? (y/N): ")
	var confirm string
	fmt.Scanln(&confirm)
	if strings.ToLower(confirm) != "y" {
		fmt.Println("Cancelled.")
		return nil
	}

	for _, name := range containers {
		cmd := exec.Command("docker", "rm", "-f", name)
		if err := cmd.Run(); err != nil {
			fmt.Printf("⚠️  Failed to remove %s: %v\n", name, err)
		} else {
			fmt.Printf("✅ Removed %s\n", name)
		}
	}
	return nil
}

func watchHealth(serviceURL string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	fmt.Printf("Watching runner service health (every %v)...\n", interval)
	fmt.Println("Press Ctrl+C to stop\n")

	for {
		select {
		case <-ticker.C:
			fmt.Printf("[%s] ", time.Now().Format("15:04:05"))
			if err := checkHealth(serviceURL); err != nil {
				fmt.Printf("❌ Error: %v\n", err)
			}
			fmt.Println()
		}
	}
}

func main() {
	var (
		health      = flag.Bool("health", false, "Check service health")
		metrics     = flag.Bool("metrics", false, "Show detailed metrics")
		cleanup     = flag.Bool("cleanup", false, "Clean up runner containers")
		watch       = flag.Bool("watch", false, "Watch health status continuously")
		prefix      = flag.String("prefix", "judge-python-worker", "Container name prefix for cleanup")
		serviceURL  = flag.String("url", defaultServiceURL, "Runner service URL")
		interval    = flag.Duration("interval", 5*time.Second, "Watch interval (for -watch)")
	)
	flag.Parse()

	if *health {
		if err := checkHealth(*serviceURL); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *metrics {
		if err := showMetrics(*serviceURL); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *cleanup {
		if err := cleanupContainers(*prefix); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *watch {
		watchHealth(*serviceURL, *interval)
		return
	}

	// Default: show health
	if err := checkHealth(*serviceURL); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

