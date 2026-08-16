import { Console } from "@/console/console";

// The console is fully client-rendered: everything it shows is live fleet
// state polled from the v1 API, so there is nothing useful to render ahead on
// the server.
export default function Page() {
  return <Console />;
}
