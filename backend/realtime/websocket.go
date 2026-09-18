package realtime

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: checkWebSocketOrigin,
}

func checkWebSocketOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}

	allowedOrigins := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
	}

	frontendURL := strings.TrimSpace(os.Getenv("FRONTEND_URL"))
	if frontendURL != "" {
		frontendURL = strings.TrimRight(frontendURL, "/")
		allowedOrigins = append(allowedOrigins, frontendURL)
	}

	for _, allowed := range allowedOrigins {
		if strings.TrimRight(origin, "/") == allowed {
			return true
		}
	}

	return false
}

// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
	clients    map[*websocket.Conn]bool
	broadcast  chan []byte
	register   chan *websocket.Conn
	unregister chan *websocket.Conn
	mu         sync.RWMutex
}

var GlobalHub = &Hub{
	clients:    make(map[*websocket.Conn]bool),
	broadcast:  make(chan []byte, 256),
	register:   make(chan *websocket.Conn),
	unregister: make(chan *websocket.Conn),
}

// StartRealtimeHub runs the hub loop and binds Redis Pub/Sub subscription if available.
func StartRealtimeHub() {
	go GlobalHub.run()

	if RedisClient != nil {
		go subscribeRedisUpdates()
		log.Println("Realtime WebSocket hub connected to Redis Pub/Sub.")
	} else {
		log.Println("Realtime WebSocket hub running in local in-memory mode.")
	}
}

func (h *Hub) run() {
	for {
		select {
		case conn := <-h.register:
			h.mu.Lock()
			h.clients[conn] = true
			h.mu.Unlock()

		case conn := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[conn]; ok {
				delete(h.clients, conn)
				_ = conn.Close()
			}
			h.mu.Unlock()

		case message := <-h.broadcast:
			h.mu.RLock()
			for conn := range h.clients {
				err := conn.WriteMessage(websocket.TextMessage, message)
				if err != nil {
					go func(c *websocket.Conn) {
						h.unregister <- c
					}(conn)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func subscribeRedisUpdates() {
	pubsub := RedisClient.Subscribe(context.Background(), "poll_updates")
	defer pubsub.Close()

	channel := pubsub.Channel()
	for msg := range channel {
		GlobalHub.broadcast <- []byte(msg.Payload)
	}
}

// BroadcastEvent publishes an event via Redis Pub/Sub (if available) and pushes to local WebSocket clients.
func BroadcastEvent(event map[string]interface{}) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}

	if RedisClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = RedisClient.Publish(ctx, "poll_updates", data).Err()
	} else {
		// Fallback for local development when Redis is not running
		GlobalHub.broadcast <- data
	}
}

func WebSocketHandler(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	GlobalHub.register <- conn

	// Keep connection alive and listen for client closure
	go func() {
		defer func() {
			GlobalHub.unregister <- conn
		}()

		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
		}
	}()
}