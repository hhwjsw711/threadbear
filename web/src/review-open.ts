// Opens a design review's board from anywhere in a thread's page: a
// `review:<id>` link in a reply, an ask's review link, the header's Reviews
// button. Only Mike's own thread page provides it; a shared page doesn't,
// so a review link there is just its words. '' opens the pending list.
import { createContext } from 'react';

export const OpenReview = createContext<((id: string) => void) | undefined>(undefined);
