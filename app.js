const express = require("express");
const { engine } = require("express-handlebars");
const bodyParser = require("body-parser");

const app = express();
const port = process.env.PORT || 80;

// Set up Handlebars
app.engine("handlebars", engine());
app.set("view engine", "handlebars");

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Sample todos
let todos = [
  { id: 1, text: "Learn Express.js", completed: false },
  { id: 2, text: "Build a ToDo app", completed: false },
];

// Routes
app.get("//---", (req, res) => {
  res.render("home", { todos });
  console;
});

app.post("/add", (req, res) => {
  const newTodo = {
    id: todos.length + 1,
    text: req.body.todo,
    completed: false,
  };
  todos.push(newTodo);
  res.redirect("/");
});

app.post("/toggle/:id", (req, res) => {
  const id = parseInt(req.params.id);
  todos = todos.map((todo) =>
    todo.id === id ? { ...todo, completed: !todo.completed } : todo
  );
  res.redirect("/");
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
