import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  userName:  { type: String, default: "Unknown" },
  userHandle:{ type: String, default: null },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Review", reviewSchema);
