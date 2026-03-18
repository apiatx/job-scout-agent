import app from "./app";

const port = Number(process.env["PORT"]) || 8080;
const FRONTEND_PORT = 25906;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

if (port !== FRONTEND_PORT) {
  app.listen(FRONTEND_PORT, () => {
    console.log(`Frontend also served on port ${FRONTEND_PORT}`);
  });
}
