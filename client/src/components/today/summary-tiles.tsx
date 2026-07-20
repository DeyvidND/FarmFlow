'use client';

import Link from 'next/link';
import { CalendarCheck, Route as RouteIcon, FileSignature, Coins } from 'lucide-react';
import { StatTile } from '@/lib/stat-ui';
import { moneyFromStotinki } from '@/lib/utils';
import type { TodaySummary } from '@/lib/types';
import {
  prepSubLine,
  routeSubLine,
  protocolsSubLine,
  codSubLine,
  tileHref,
} from './tiles-logic';

/** A `StatTile` wrapped in a deep-link to its own screen. StatTile already carries
 *  the card convention (rounded-xl border + green top accent + shadow-ff-sm). */
function TileLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className="block no-underline transition hover:brightness-[0.99]">
      {children}
    </Link>
  );
}

export function PrepTile({ prep, index = 0 }: { prep: TodaySummary['prep']; index?: number }) {
  return (
    <TileLink href={tileHref.prep}>
      <StatTile Icon={CalendarCheck} label="Подготовка" value={prep.ordersToPrep} sub={prepSubLine(prep)} index={index} />
    </TileLink>
  );
}

export function RouteTile({ route, index = 0 }: { route: TodaySummary['route']; index?: number }) {
  return (
    <TileLink href={tileHref.route}>
      <StatTile Icon={RouteIcon} label="Маршрут" value={route.stops} sub={routeSubLine(route)} index={index} />
    </TileLink>
  );
}

export function ProtocolsTile({ protocols, index = 0 }: { protocols: TodaySummary['protocols']; index?: number }) {
  return (
    <TileLink href={tileHref.protocols}>
      <StatTile Icon={FileSignature} label="Протоколи" value={protocols.total} sub={protocolsSubLine(protocols)} index={index} />
    </TileLink>
  );
}

export function CodTile({ cod, index = 0 }: { cod: TodaySummary['cod']; index?: number }) {
  return (
    <TileLink href={tileHref.cod}>
      <StatTile Icon={Coins} label="Пари днес" value={moneyFromStotinki(cod.toCollectStotinki)} sub={codSubLine(cod)} index={index} />
    </TileLink>
  );
}
