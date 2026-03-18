import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";

const app: Express = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../dist/public");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use(express.static(FRONTEND_DIST));
app.use((_req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"));
});

export default app;
