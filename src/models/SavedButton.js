import mongoose from "mongoose";

const savedButtonSchema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  label:     { type: String, required: true },
  url:       { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("SavedButton", savedButtonSchema);
