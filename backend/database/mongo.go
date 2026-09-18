package database

import (
	"context"
	"log"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var Client *mongo.Client
var DB *mongo.Database
var IsInMemory bool

func ConnectMongoDB() {
	mongoURI := os.Getenv("MONGO_URI")

	if mongoURI == "" {
		log.Fatal("MONGO_URI is not set")
	}

	ctx, cancel := context.WithTimeout(
		context.Background(),
		15*time.Second,
	)
	defer cancel()

	client, err := mongo.Connect(
		options.Client().ApplyURI(mongoURI),
	)

	if err != nil {
		log.Fatal("Could not create MongoDB client:", err)
	}

	if err := client.Ping(ctx, nil); err != nil {
		log.Println("================================================================")
		log.Println("WARNING: Could not connect to MongoDB Atlas!")
		log.Println("Details:", err)
		log.Println("NOTE: Your current IP address is likely not whitelisted in MongoDB Atlas.")
		log.Println("Fix: In MongoDB Atlas (cloud.mongodb.com) -> Network Access -> Add IP Address -> Allow (0.0.0.0/0).")
		log.Println("STATUS: Operating in local in-memory fallback mode so the server stays active.")
		log.Println("================================================================")
		IsInMemory = true
		return
	}

	Client = client

	// Database name.
	DB = Client.Database("pulsepoll")

	// Create unique email index.
	usersCollection := DB.Collection("users")

	_, err = usersCollection.Indexes().CreateOne(
		context.Background(),
		mongo.IndexModel{
			Keys: map[string]int{
				"email": 1,
			},
			Options: options.Index().SetUnique(true),
		},
	)

	if err != nil {
		log.Fatal("Could not create email index:", err)
	}

	log.Println("MongoDB connected successfully!")
}