package middleware

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"pulsepoll/backend/utils"

	"github.com/gin-gonic/gin"
)

func TestAuthMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	os.Setenv("JWT_SECRET", "test-secret")

	token, err := utils.GenerateToken("user123", "test@example.com")
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	router := gin.New()
	router.Use(AuthMiddleware())
	router.GET("/protected", func(c *gin.Context) {
		uid, _ := c.Get("user_id")
		email, _ := c.Get("email")
		c.JSON(http.StatusOK, gin.H{"uid": uid, "email": email})
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestOptionalAuthMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	os.Setenv("JWT_SECRET", "test-secret")

	router := gin.New()
	router.Use(OptionalAuthMiddleware())
	router.GET("/optional", func(c *gin.Context) {
		uid, exists := c.Get("user_id")
		if !exists {
			uid = "anonymous"
		}
		c.JSON(http.StatusOK, gin.H{"uid": uid})
	})

	// Case 1: Unauthenticated request should succeed with anonymous
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest("GET", "/optional", nil)
	router.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for guest, got %d", w1.Code)
	}

	// Case 2: Authenticated request should extract user_id
	token, _ := utils.GenerateToken("user456", "guest@example.com")
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest("GET", "/optional", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	router.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("Expected status 200 for auth user, got %d", w2.Code)
	}
}

