import { Route, Switch } from "wouter";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import NodeDetail from "./pages/NodeDetail";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/nodes/:id" component={NodeDetail} />
      <Route path="/app" component={Admin} />
    </Switch>
  );
}
