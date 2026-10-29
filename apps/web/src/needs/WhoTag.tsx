import { User, Users } from 'lucide-react';
import { Badge } from '../ui/badge';
import { whoLabel, type Who } from './logic';

/** "Only you" (only this person can act) or "You or others · Ana, Product team" (item 2YZRd). */
export function WhoTag({ who }: { who: Who }) {
  return (
    <Badge tone={who.only ? 'gate' : 'neutral'} className="max-w-full">
      {who.only ? <User size={10} aria-hidden /> : <Users size={10} aria-hidden />}
      <span data-who={who.only ? 'only' : 'shared'} className="truncate">
        {whoLabel(who)}
      </span>
    </Badge>
  );
}
