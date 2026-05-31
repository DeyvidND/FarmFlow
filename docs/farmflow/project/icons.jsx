/* FarmFlow icons — simple, consistent stroke icons */
const Icon = ({ children, size = 22, stroke = 1.8, fill = "none", ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}
    stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {children}
  </svg>
);

const IconDashboard = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

const IconOrders = (p) => (
  <Icon {...p}>
    <path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v5h5" />
    <path d="M8 13h8M8 17h5" />
  </Icon>
);

const IconProducts = (p) => (
  <Icon {...p}>
    <path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z" />
    <path d="M3.5 8.5 12 13l8.5-4.5M12 13v7" />
  </Icon>
);

const IconSlots = (p) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v3M16 3v3" />
    <circle cx="8.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

const IconRoute = (p) => (
  <Icon {...p}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M8.2 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.6" />
  </Icon>
);

const IconBell = (p) => (
  <Icon {...p}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Icon>
);

const IconPhone = (p) => (
  <Icon {...p}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
  </Icon>
);

const IconCheck = (p) => (
  <Icon {...p}><path d="M20 6 9 17l-5-5" /></Icon>
);

const IconCheckAll = (p) => (
  <Icon {...p}><path d="M2 12.5 7 17l3.5-3.5M12 13l1.5 1.5L22 6M9.5 13 15 7.5" /></Icon>
);

const IconClose = (p) => (
  <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>
);

const IconPlus = (p) => (
  <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
);

const IconChevron = (p) => (
  <Icon {...p}><path d="m9 18 6-6-6-6" /></Icon>
);

const IconChevronDown = (p) => (
  <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
);

const IconPin = (p) => (
  <Icon {...p}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="2.6" />
  </Icon>
);

const IconTruck = (p) => (
  <Icon {...p}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h9A1.5 1.5 0 0 1 15 6.5V16H3V6.5Z" />
    <path d="M15 9h3.4a1.5 1.5 0 0 1 1.3.8L21.5 13v3H15V9Z" />
    <circle cx="7" cy="18" r="1.8" />
    <circle cx="17.5" cy="18" r="1.8" />
  </Icon>
);

const IconBox = (p) => (
  <Icon {...p}>
    <path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z" />
    <path d="M3.5 8.5 12 13l8.5-4.5M12 13v7" />
  </Icon>
);

const IconClock = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
);

const IconCoins = (p) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6.5" rx="7" ry="3" />
    <path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    <path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
  </Icon>
);

const IconHourglass = (p) => (
  <Icon {...p}>
    <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 16M16 4c0 5-8 5-8 16" />
  </Icon>
);

const IconSearch = (p) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Icon>
);

const IconEdit = (p) => (
  <Icon {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </Icon>
);

const IconImage = (p) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 16-5-5L5 20" />
  </Icon>
);

const IconLeaf = (p) => (
  <Icon {...p}>
    <path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 16-9 0 12-4 16-9 16Z" />
    <path d="M4 20c4-6 7-8 12-9" />
  </Icon>
);

const IconLogout = (p) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Icon>
);

const IconBasket = (p) => (
  <Icon {...p}>
    <path d="M5 10 12 3l7 7" />
    <path d="M3 10h18l-1.4 8.3a2 2 0 0 1-2 1.7H6.4a2 2 0 0 1-2-1.7L3 10Z" />
    <path d="M9 14v2M15 14v2" />
  </Icon>
);

const IconNavigate = (p) => (
  <Icon {...p}>
    <path d="M3 11 21 3l-8 18-2-7-8-3Z" />
  </Icon>
);

const IconMenu = (p) => (
  <Icon {...p}><path d="M3 6h18M3 12h18M3 18h18" /></Icon>
);

Object.assign(window, {
  Icon, IconDashboard, IconOrders, IconProducts, IconSlots, IconRoute,
  IconBell, IconPhone, IconCheck, IconCheckAll, IconClose, IconPlus,
  IconChevron, IconChevronDown, IconPin, IconTruck, IconBox, IconClock,
  IconCoins, IconHourglass, IconSearch, IconEdit, IconImage, IconLeaf, IconLogout, IconBasket, IconNavigate, IconMenu,
});
