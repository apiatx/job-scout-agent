import app from "./app";

const port = Number(process.env["PORT"]) || 8080;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

if (process.env.NODE_ENV !== "production" && port !== 5000) {
  app.listen(5000, () => {
    console.log(`Preview also available on port 5000`);
  });
}
