package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"pulsepoll/backend/database"
	"pulsepoll/backend/models"
	"pulsepoll/backend/realtime"
)

type CreatePollRequest struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// --------------------------------------------------
// CREATE POLL
// --------------------------------------------------

func CreatePoll(c *gin.Context) {

	var request CreatePollRequest

	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid request data",
		})
		return
	}

	request.Question = strings.TrimSpace(request.Question)

	if request.Question == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Question is required",
		})
		return
	}

	if len(request.Question) > 300 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Question cannot exceed 300 characters",
		})
		return
	}

	if len(request.Options) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "At least 2 options are required",
		})
		return
	}

	if len(request.Options) > 10 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Maximum 10 options are allowed",
		})
		return
	}

	cleanOptions := make([]string, 0, len(request.Options))
	seenOptions := make(map[string]bool)

	for _, option := range request.Options {

		option = strings.TrimSpace(option)

		if option == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Options cannot be empty",
			})
			return
		}

		if len(option) > 100 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Each option cannot exceed 100 characters",
			})
			return
		}

		optionKey := strings.ToLower(option)

		if seenOptions[optionKey] {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Duplicate options are not allowed",
			})
			return
		}

		seenOptions[optionKey] = true
		cleanOptions = append(cleanOptions, option)
	}

	// --------------------------------------------------
	// GET LOGGED-IN USER
	// --------------------------------------------------

	userID, exists := c.Get("user_id")

	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "User authentication required",
		})
		return
	}

	userIDString, ok := userID.(string)

	if !ok || userIDString == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid user information",
		})
		return
	}

	// --------------------------------------------------
	// CREATE POLL
	// --------------------------------------------------

	votes := make([]int, len(cleanOptions))

	poll := models.Poll{
		ID:        bson.NewObjectID(),
		Question:  request.Question,
		Options:   cleanOptions,
		Votes:     votes,
		Voters:    []string{},
		CreatedBy: userIDString,
		Status:    "active",
	}

	if database.IsInMemory {
		_ = database.MemStore.SavePoll(poll)
	} else {
		collection := database.DB.Collection("polls")
		_, err := collection.InsertOne(
			c.Request.Context(),
			poll,
		)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not create poll",
			})
			return
		}
	}

	// --------------------------------------------------
	// INITIALIZE REDIS LIVE COUNTERS
	// --------------------------------------------------

	realtime.InitPollLiveCounts(
		c.Request.Context(),
		poll.ID.Hex(),
		len(poll.Options),
	)

	// --------------------------------------------------
	// PUBLISH REDIS EVENT
	// --------------------------------------------------

	publishPollEvent(
		"poll_created",
		map[string]interface{}{
			"type":      "poll_created",
			"poll":      poll,
			"pollId":    poll.ID.Hex(),
			"timestamp": time.Now().Unix(),
		},
	)

	// --------------------------------------------------
	// RESPONSE
	// --------------------------------------------------

	c.JSON(http.StatusCreated, gin.H{
		"message": "Poll created successfully",
		"poll":    poll,
	})
}

// --------------------------------------------------
// GET ALL POLLS
// --------------------------------------------------

func GetAllPolls(c *gin.Context) {

	var polls []models.Poll

	if database.IsInMemory {
		polls = database.MemStore.GetAllPolls()
	} else {
		collection := database.DB.Collection("polls")

		cursor, err := collection.Find(
			c.Request.Context(),
			bson.M{},
		)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not fetch polls",
			})
			return
		}

		defer cursor.Close(c.Request.Context())

		if err := cursor.All(
			c.Request.Context(),
			&polls,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not read polls",
			})
			return
		}
	}

	if polls == nil {
		polls = []models.Poll{}
	}

	c.JSON(http.StatusOK, gin.H{
		"polls": polls,
	})
}

// --------------------------------------------------
// GET SINGLE POLL
// --------------------------------------------------

func GetPoll(c *gin.Context) {

	pollID := c.Param("id")

	objectID, err := bson.ObjectIDFromHex(pollID)

	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid poll ID",
		})
		return
	}

	var poll models.Poll

	if database.IsInMemory {
		p, err := database.MemStore.GetPollByID(pollID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Poll not found",
			})
			return
		}
		poll = *p
	} else {
		collection := database.DB.Collection("polls")
		err = collection.FindOne(
			c.Request.Context(),
			bson.M{
				"_id": objectID,
			},
		).Decode(&poll)

		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Poll not found",
			})
			return
		}
	}

	// Check if this requester has already voted
	hasVoted := false
	if uid, exists := c.Get("user_id"); exists {
		if uidStr, ok := uid.(string); ok && uidStr != "" {
			userKey := "user:" + uidStr
			for _, v := range poll.Voters {
				if v == userKey || v == uidStr {
					hasVoted = true
					break
				}
			}
		}
	}

	if !hasVoted {
		guestVoter := strings.TrimSpace(c.Query("voterId"))
		if guestVoter == "" {
			guestVoter = strings.TrimSpace(c.GetHeader("X-Voter-ID"))
		}
		if guestVoter != "" {
			guestKey := "guest:" + guestVoter
			for _, v := range poll.Voters {
				if v == guestKey || v == guestVoter {
					hasVoted = true
					break
				}
			}
		}
	}

	// Synchronize with live in-memory tallies from Redis if available
	if liveVotes, ok := realtime.GetPollLiveCounts(c.Request.Context(), poll.ID.Hex(), len(poll.Options)); ok {
		poll.Votes = liveVotes
	}

	c.JSON(http.StatusOK, gin.H{
		"id":        poll.ID.Hex(),
		"question":  poll.Question,
		"options":   poll.Options,
		"votes":     poll.Votes,
		"createdBy": poll.CreatedBy,
		"status":    poll.Status,
		"hasVoted":  hasVoted,
		"poll":      poll,
	})
}

// --------------------------------------------------
// VOTE POLL
// --------------------------------------------------

func VotePoll(c *gin.Context) {

	pollID := c.Param("id")

	objectID, err := bson.ObjectIDFromHex(pollID)

	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid poll ID",
		})
		return
	}

	// --------------------------------------------------
	// GET VOTER IDENTITY (User or Guest)
	// --------------------------------------------------

	var voterKey string
	var isAuthUser bool

	userID, exists := c.Get("user_id")
	if exists {
		if uidStr, ok := userID.(string); ok && strings.TrimSpace(uidStr) != "" {
			voterKey = "user:" + strings.TrimSpace(uidStr)
			isAuthUser = true
		}
	}

	var request struct {
		OptionIndex int    `json:"optionIndex"`
		VoterID     string `json:"voterId"`
	}

	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid vote data",
		})
		return
	}

	if voterKey == "" {
		guestVoter := strings.TrimSpace(request.VoterID)
		if guestVoter == "" {
			guestVoter = strings.TrimSpace(c.GetHeader("X-Voter-ID"))
		}
		if guestVoter == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Voter identification (voterId) is required",
			})
			return
		}
		if len(guestVoter) > 128 {
			guestVoter = guestVoter[:128]
		}
		voterKey = "guest:" + guestVoter
	}

	var poll models.Poll

	if database.IsInMemory {
		p, err := database.MemStore.GetPollByID(pollID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Poll not found",
			})
			return
		}
		poll = *p
	} else {
		collection := database.DB.Collection("polls")
		err = collection.FindOne(
			c.Request.Context(),
			bson.M{
				"_id": objectID,
			},
		).Decode(&poll)

		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Poll not found",
			})
			return
		}
	}

	// --------------------------------------------------
	// CHECK POLL STATUS
	// --------------------------------------------------

	if poll.Status != "active" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "This poll is not active",
		})
		return
	}

	// --------------------------------------------------
	// VALIDATE OPTION
	// --------------------------------------------------

	if request.OptionIndex < 0 ||
		request.OptionIndex >= len(poll.Options) {

		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid option",
		})
		return
	}

	// --------------------------------------------------
	// VALIDATE VOTE ARRAY
	// --------------------------------------------------

	if len(poll.Votes) != len(poll.Options) {

		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Poll vote data is invalid",
		})
		return
	}

	// --------------------------------------------------
	// FAST REDIS DUPLICATE VOTE CHECK
	// --------------------------------------------------

	if realtime.HasVoterVotedLive(c.Request.Context(), poll.ID.Hex(), voterKey) {
		c.JSON(http.StatusConflict, gin.H{
			"error": "You have already voted in this poll",
		})
		return
	}

	// --------------------------------------------------
	// ATOMIC VOTE UPDATE
	// --------------------------------------------------

	if database.IsInMemory {
		updatedPoll, err := database.MemStore.RecordVote(pollID, request.OptionIndex, voterKey)
		if err != nil {
			if err.Error() == "already voted" {
				c.JSON(http.StatusConflict, gin.H{
					"error": "You have already voted in this poll",
				})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
			})
			return
		}
		poll = *updatedPoll
	} else {
		collection := database.DB.Collection("polls")
		voteField := "votes." + strconv.Itoa(request.OptionIndex)

		neConditions := []bson.M{
			{"voters": bson.M{"$ne": voterKey}},
		}
		if isAuthUser {
			rawUID, _ := userID.(string)
			neConditions = append(neConditions, bson.M{"voters": bson.M{"$ne": rawUID}})
		}

		filter := bson.M{
			"_id":    objectID,
			"status": "active",
			"$and":   neConditions,
		}

		result, err := collection.UpdateOne(
			c.Request.Context(),
			filter,
			bson.M{
				"$inc": bson.M{
					voteField: 1,
				},
				"$push": bson.M{
					"voters": voterKey,
				},
			},
		)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not record vote",
			})
			return
		}

		if result.ModifiedCount == 0 {
			var currentPoll models.Poll

			err = collection.FindOne(
				c.Request.Context(),
				bson.M{
					"_id": objectID,
				},
			).Decode(&currentPoll)

			if err != nil {
				c.JSON(http.StatusNotFound, gin.H{
					"error": "Poll not found",
				})
				return
			}

			if currentPoll.Status != "active" {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "This poll is not active",
				})
				return
			}

			for _, voterID := range currentPoll.Voters {
				if voterID == voterKey || (isAuthUser && voterID == userID.(string)) {
					c.JSON(http.StatusConflict, gin.H{
						"error": "You have already voted in this poll",
					})
					return
				}
			}

			c.JSON(http.StatusConflict, gin.H{
				"error": "Vote could not be recorded",
			})
			return
		}

		err = collection.FindOne(
			c.Request.Context(),
			bson.M{
				"_id": objectID,
			},
		).Decode(&poll)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Vote recorded but could not fetch updated poll",
			})
			return
		}
	}

	// --------------------------------------------------
	// UPDATE REDIS LIVE IN-MEMORY TALLIES & VOTER SET
	// --------------------------------------------------

	if liveVotes, _, _ := realtime.IncrementPollLiveVote(
		c.Request.Context(),
		poll.ID.Hex(),
		request.OptionIndex,
		voterKey,
		len(poll.Options),
	); len(liveVotes) == len(poll.Votes) {
		poll.Votes = liveVotes
	}

	// --------------------------------------------------
	// PUBLISH LIVE VOTE UPDATE
	// --------------------------------------------------

	publishPollEvent(
		"vote",
		map[string]interface{}{
			"type":        "vote",
			"pollId":      poll.ID.Hex(),
			"votes":       poll.Votes,
			"totalVotes":  totalVotes(poll.Votes),
			"optionIndex": request.OptionIndex,
			"timestamp":   time.Now().Unix(),
		},
	)

	// --------------------------------------------------
	// RESPONSE
	// --------------------------------------------------

	c.JSON(http.StatusOK, gin.H{
		"message": "Vote recorded successfully",
		"poll":    poll,
	})
}

// --------------------------------------------------
// CLOSE POLL
// --------------------------------------------------

func ClosePoll(c *gin.Context) {

	pollID := c.Param("id")

	objectID, err := bson.ObjectIDFromHex(pollID)

	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Invalid poll ID",
		})
		return
	}

	// --------------------------------------------------
	// GET LOGGED-IN USER
	// --------------------------------------------------

	userID, exists := c.Get("user_id")

	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "User authentication required",
		})
		return
	}

	userIDString, ok := userID.(string)

	if !ok || userIDString == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "Invalid user information",
		})
		return
	}

	var poll models.Poll

	if database.IsInMemory {
		closedPoll, err := database.MemStore.ClosePoll(pollID, userIDString)
		if err != nil {
			if strings.Contains(err.Error(), "unauthorized") {
				c.JSON(http.StatusForbidden, gin.H{
					"error": "Only the poll creator can close this poll",
				})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{
				"error": err.Error(),
			})
			return
		}
		poll = *closedPoll
	} else {
		collection := database.DB.Collection("polls")

		err = collection.FindOne(
			c.Request.Context(),
			bson.M{
				"_id": objectID,
			},
		).Decode(&poll)

		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Poll not found",
			})
			return
		}

		if poll.CreatedBy != userIDString {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Only the poll creator can close this poll",
			})
			return
		}

		if poll.Status == "closed" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Poll is already closed",
			})
			return
		}

		result, err := collection.UpdateOne(
			c.Request.Context(),
			bson.M{
				"_id": objectID,
				"status": "active",
			},
			bson.M{
				"$set": bson.M{
					"status": "closed",
				},
			},
		)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Could not close poll",
			})
			return
		}

		if result.ModifiedCount == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "Poll is already closed",
			})
			return
		}

		poll.Status = "closed"
	}

	// --------------------------------------------------
	// PUBLISH POLL CLOSED EVENT
	// --------------------------------------------------

	publishPollEvent(
		"poll_closed",
		map[string]interface{}{
			"type":      "poll_closed",
			"pollId":    poll.ID.Hex(),
			"status":    "closed",
			"timestamp": time.Now().Unix(),
		},
	)

	// --------------------------------------------------
	// RESPONSE
	// --------------------------------------------------

	c.JSON(http.StatusOK, gin.H{
		"message": "Poll closed successfully",
		"poll":    poll,
	})
}

// --------------------------------------------------
// REDIS EVENT HELPER
// --------------------------------------------------

func publishPollEvent(
	eventType string,
	event map[string]interface{},
) {
	event["type"] = eventType
	realtime.BroadcastEvent(event)
}

// --------------------------------------------------
// TOTAL VOTES
// --------------------------------------------------

func totalVotes(votes []int) int {

	total := 0

	for _, vote := range votes {
		total += vote
	}

	return total
}