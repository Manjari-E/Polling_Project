package middleware

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {

		// Get Authorization header
		authHeader := strings.TrimSpace(
			c.GetHeader("Authorization"),
		)

		if authHeader == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Authorization token is required",
			})
			c.Abort()
			return
		}

		// Expected format:
		// Bearer <token>
		parts := strings.SplitN(authHeader, " ", 2)

		if len(parts) != 2 ||
			!strings.EqualFold(parts[0], "Bearer") ||
			strings.TrimSpace(parts[1]) == "" {

			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid authorization format",
			})
			c.Abort()
			return
		}

		tokenString := strings.TrimSpace(parts[1])

		// Get JWT secret
		secret := strings.TrimSpace(os.Getenv("JWT_SECRET"))

		if secret == "" {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "JWT secret is not configured",
			})
			c.Abort()
			return
		}

		// Parse and validate JWT
		token, err := jwt.Parse(
			tokenString,
			func(token *jwt.Token) (interface{}, error) {

				// Only allow HS256
				if token.Method != jwt.SigningMethodHS256 {
					return nil, jwt.ErrSignatureInvalid
				}

				return []byte(secret), nil
			},
		)

		if err != nil || !token.Valid {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid or expired token",
			})
			c.Abort()
			return
		}

		// Get JWT claims
		claims, ok := token.Claims.(jwt.MapClaims)

		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid token claims",
			})
			c.Abort()
			return
		}

		// Get user ID
		userID, ok := claims["user_id"].(string)

		if !ok || strings.TrimSpace(userID) == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid user information",
			})
			c.Abort()
			return
		}

		// Get email
		email, _ := claims["email"].(string)

		// Store user information for handlers
		c.Set("user_id", userID)
		c.Set("email", email)

		// Continue to requested handler
		c.Next()
	}
}

// OptionalAuthMiddleware inspects the Authorization header if present.
// If valid token is supplied, it extracts user_id and email into context.
// If no token is supplied, it proceeds without error as guest.
func OptionalAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
		if authHeader == "" {
			c.Next()
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
			c.Next()
			return
		}

		secret := strings.TrimSpace(os.Getenv("JWT_SECRET"))
		if secret == "" {
			c.Next()
			return
		}

		token, err := jwt.Parse(parts[1], func(token *jwt.Token) (interface{}, error) {
			if token.Method != jwt.SigningMethodHS256 {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(secret), nil
		})

		if err == nil && token.Valid {
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				if userID, ok := claims["user_id"].(string); ok && strings.TrimSpace(userID) != "" {
					c.Set("user_id", userID)
				}
				if email, ok := claims["email"].(string); ok {
					c.Set("email", email)
				}
			}
		}

		c.Next()
	}
}