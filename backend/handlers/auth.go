package handlers

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"golang.org/x/crypto/bcrypt"

	"pulsepoll/backend/database"
	"pulsepoll/backend/models"
	"pulsepoll/backend/utils"
)

type SignupRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func Signup(c *gin.Context) {
	var request SignupRequest

	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid request data",
		})
		return
	}

	request.Name = strings.TrimSpace(request.Name)
	request.Email = strings.ToLower(strings.TrimSpace(request.Email))

	if request.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Name is required",
		})
		return
	}

	if len(request.Name) < 2 || len(request.Name) > 70 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Name must be between 2 and 70 characters",
		})
		return
	}

	if request.Email == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Email is required",
		})
		return
	}

	if len(request.Email) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Email cannot exceed 150 characters",
		})
		return
	}

	emailRegex := regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
	if !emailRegex.MatchString(request.Email) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Please provide a valid email address",
		})
		return
	}

	if len(request.Password) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Password must be at least 6 characters",
		})
		return
	}

	if len(request.Password) > 72 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Password cannot exceed 72 characters",
		})
		return
	}

	hashedPassword, err := bcrypt.GenerateFromPassword(
		[]byte(request.Password),
		bcrypt.DefaultCost,
	)

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Could not secure password",
		})
		return
	}

	user := models.User{
		ID:       bson.NewObjectID(),
		Name:     request.Name,
		Email:    request.Email,
		Password: string(hashedPassword),
	}

	if database.IsInMemory {
		if err := database.MemStore.SaveUser(user); err != nil {
			c.JSON(http.StatusConflict, gin.H{
				"error": "Email is already registered",
			})
			return
		}
	} else {
		collection := database.DB.Collection("users")
		_, err = collection.InsertOne(
			c.Request.Context(),
			user,
		)

		if err != nil {
			if mongo.IsDuplicateKeyError(err) {
				c.JSON(http.StatusConflict, gin.H{
					"error": "Email is already registered",
				})
				return
			}

			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not create user",
			})
			return
		}
	}

	c.JSON(http.StatusCreated, gin.H{
		"message": "User created successfully",
		"user": gin.H{
			"id":    user.ID.Hex(),
			"name":  user.Name,
			"email": user.Email,
		},
	})
}

func Login(c *gin.Context) {
	var request LoginRequest

	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid request data",
		})
		return
	}

	request.Email = strings.ToLower(
		strings.TrimSpace(request.Email),
	)

	if request.Email == "" || request.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Email and password are required",
		})
		return
	}

	var user models.User

	if database.IsInMemory {
		memUser, err := database.MemStore.FindUserByEmail(request.Email)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid email or password",
			})
			return
		}
		user = *memUser
	} else {
		collection := database.DB.Collection("users")
		err := collection.FindOne(
			c.Request.Context(),
			bson.M{
				"email": request.Email,
			},
		).Decode(&user)

		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid email or password",
			})
			return
		}
	}

	err := bcrypt.CompareHashAndPassword(
		[]byte(user.Password),
		[]byte(request.Password),
	)

	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid email or password",
		})
		return
	}

	token, err := utils.GenerateToken(
		user.ID.Hex(),
		user.Email,
	)

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Could not create authentication token",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Login successful",
		"token":   token,
		"user": gin.H{
			"id":    user.ID.Hex(),
			"name":  user.Name,
			"email": user.Email,
		},
	})
}