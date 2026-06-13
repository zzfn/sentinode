import { Route, Switch } from "wouter";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import NodeDetail from "./pages/NodeDetail";
import Status from "./pages/Status";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/nodes/:id" component={NodeDetail} />
      <Route path="/app/login" component={Login} />
      <Route path="/app" component={Admin} />
      <Route path="/app/:section" component={Admin} />
      <Route path="/status" component={Status} />
    </Switch>
  );
}
