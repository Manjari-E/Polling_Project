package routes

import (
	"github.com/gin-gonic/gin"

	"pulsepoll/backend/handlers"
	"pulsepoll/backend/middleware"
	"pulsepoll/backend/realtime"
)

func SetupRoutes(router *gin.Engine) {

	// Authentication
	auth := router.Group("/api/auth")
	{
		auth.POST("/signup", handlers.Signup)
		auth.POST("/login", handlers.Login)
		auth.POST("/google", handlers.GoogleAuth)
	}

	// Polls
	polls := router.Group("/api/polls")
	{
		polls.GET("/", handlers.GetAllPolls)
		polls.GET("/:id", middleware.OptionalAuthMiddleware(), handlers.GetPoll)

		polls.POST(
			"/",
			middleware.AuthMiddleware(),
			handlers.CreatePoll,
		)

		polls.POST(
			"/:id/vote",
			middleware.OptionalAuthMiddleware(),
			handlers.VotePoll,
		)

		polls.POST(
			"/:id/close",
			middleware.AuthMiddleware(),
			handlers.ClosePoll,
		)
	}

	// Realtime
	router.GET("/ws", realtime.WebSocketHandler)
}