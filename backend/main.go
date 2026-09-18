package main

import (
	"log"
	"os"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

	"pulsepoll/backend/database"
	"pulsepoll/backend/realtime"
	"pulsepoll/backend/routes"
)

func main() {

	// Load .env locally.
	// Render uses environment variables.
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found. Using environment variables.")
	}

	// -----------------------------
	// CONNECT MONGODB
	// -----------------------------

	database.ConnectMongoDB()

	// -----------------------------
	// CONNECT REDIS
	// -----------------------------

	realtime.ConnectRedis()
	realtime.StartRealtimeHub()

	// -----------------------------
	// CREATE ROUTER
	// -----------------------------

	router := gin.Default()

	// -----------------------------
	// CORS
	// -----------------------------

	allowedOrigins := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
	}

	frontendURL := strings.TrimSpace(
		os.Getenv("FRONTEND_URL"),
	)

	if frontendURL != "" {
		frontendURL = strings.TrimRight(
			frontendURL,
			"/",
		)

		found := false

		for _, origin := range allowedOrigins {
			if origin == frontendURL {
				found = true
				break
			}
		}

		if !found {
			allowedOrigins = append(
				allowedOrigins,
				frontendURL,
			)
		}
	}

	router.Use(cors.New(cors.Config{
		AllowOrigins: allowedOrigins,

		AllowMethods: []string{
			"GET",
			"POST",
			"PUT",
			"DELETE",
			"OPTIONS",
		},

		AllowHeaders: []string{
			"Origin",
			"Content-Type",
			"Authorization",
		},

		AllowCredentials: true,
	}))

	// -----------------------------
	// HEALTH CHECK
	// -----------------------------

	router.GET("/", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"message": "PulsePoll backend is running!",
		})
	})

	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"status": "ok",
		})
	})

	// -----------------------------
	// API ROUTES
	// -----------------------------

	routes.SetupRoutes(router)

	// -----------------------------
	// PORT
	// -----------------------------

	port := strings.TrimSpace(
		os.Getenv("PORT"),
	)

	if port == "" {
		port = "10000"
	}

	log.Println(
		"PulsePoll server starting on port:",
		port,
	)

	// Render requires 0.0.0.0:$PORT.
	if err := router.Run(
		"0.0.0.0:" + port,
	); err != nil {

		log.Fatal(
			"Server failed to start:",
			err,
		)
	}
}