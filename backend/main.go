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

	router.Use(cors.New(cors.Config{
		AllowOriginFunc: func(origin string) bool {
			// Allow all origins (mobile browsers, Vercel deployments, etc.)
			return true
		},

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
			"X-Voter-ID",
			"Accept",
			"X-Requested-With",
			"ngrok-skip-browser-warning",
		},

		ExposeHeaders: []string{
			"Content-Length",
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