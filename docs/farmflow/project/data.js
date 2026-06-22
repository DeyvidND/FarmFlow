/* ФермериБГ — fake data layer (Bulgarian). Exposed as window.FF */
(function () {
  // ---- Products ----
  const products = [
    { id: "p1", name: "Ягоди", weight: "500 г", price: 6.50, stock: 24, active: true, tint: "#D94A4A", cat: "Плодове" },
    { id: "p2", name: "Боровинки", weight: "250 г", price: 7.90, stock: 12, active: true, tint: "#5B5BA8", cat: "Плодове" },
    { id: "p3", name: "Малини", weight: "500 г", price: 8.20, stock: 6, active: true, tint: "#C0426B", cat: "Плодове" },
    { id: "p4", name: "Къпини", weight: "250 г", price: 5.80, stock: 0, active: false, tint: "#3B3B57", cat: "Плодове" },
    { id: "p5", name: "Череши", weight: "1 кг", price: 9.40, stock: 18, active: true, tint: "#A11E2E", cat: "Плодове" },
    { id: "p6", name: "Сироп от ягоди", weight: "330 мл", price: 11.00, stock: 9, active: true, tint: "#C13A52", cat: "Преработени" },
    { id: "p7", name: "Домашно сладко малина", weight: "320 г", price: 9.90, stock: 14, active: true, tint: "#B23B5E", cat: "Преработени" },
    { id: "p8", name: "Мед липов", weight: "450 г", price: 13.50, stock: 7, active: true, tint: "#D89A2B", cat: "Преработени" },
    { id: "p9", name: "Арон섯", weight: "250 г", price: 6.20, stock: 4, active: true, tint: "#4A2E55", cat: "Плодове" },
  ];
  // fix accidental char
  products[8].name = "Арония";

  // ---- Orders ----
  // statuses: pending | confirmed | delivered | cancelled
  const orders = [
    { id: "1042", time: "08:14", customer: "Иван Петров", phone: "+359 88 412 7733",
      items: [{ name: "Ягоди 500 г", qty: 2 }, { name: "Сироп от ягоди 330 мл", qty: 1 }],
      delivery: "Адрес", address: "ул. Цар Симеон 12, Варна", note: "Звънец не работи, моля обадете се.",
      status: "pending", total: 24.00, slot: "10:00 – 11:00" },
    { id: "1041", time: "08:02", customer: "Мария Георгиева", phone: "+359 89 553 1290",
      items: [{ name: "Боровинки 250 г", qty: 3 }],
      delivery: "Еконт", address: "Еконт офис — ул. Осми Приморски полк 54", note: "",
      status: "pending", total: 23.70, slot: "11:00 – 12:00" },
    { id: "1040", time: "07:51", customer: "Димитър Иванов", phone: "+359 88 901 6655",
      items: [{ name: "Малини 500 г", qty: 1 }, { name: "Череши 1 кг", qty: 1 }, { name: "Мед липов 450 г", qty: 1 }],
      delivery: "Адрес", address: "бул. Сливница 45, вх. Б, ет. 3, Варна", note: "",
      status: "pending", total: 31.10, slot: "10:00 – 11:00" },
    { id: "1039", time: "07:38", customer: "Елена Стоянова", phone: "+359 87 220 4418",
      items: [{ name: "Домашно сладко малина 320 г", qty: 2 }],
      delivery: "Адрес", address: "ул. Драган Цанков 8, Варна", note: "Предпочита доставка преди обяд.",
      status: "pending", total: 19.80, slot: "11:00 – 12:00" },
    { id: "1038", time: "07:22", customer: "Георги Тодоров", phone: "+359 88 174 9920",
      items: [{ name: "Ягоди 500 г", qty: 3 }],
      delivery: "Адрес", address: "ул. Княз Борис I 102, Варна", note: "",
      status: "confirmed", total: 19.50, slot: "10:00 – 11:00" },
    { id: "1037", time: "07:05", customer: "Николай Димитров", phone: "+359 89 008 3471",
      items: [{ name: "Боровинки 250 г", qty: 2 }, { name: "Малини 500 г", qty: 1 }],
      delivery: "Еконт", address: "Еконт офис — бул. Владислав Варненчик 277", note: "",
      status: "confirmed", total: 24.00, slot: "12:00 – 13:00" },
    { id: "1036", time: "06:54", customer: "Анна Колева", phone: "+359 88 663 2017",
      items: [{ name: "Череши 1 кг", qty: 2 }],
      delivery: "Адрес", address: "ж.к. Чайка, бл. 24, вх. А, Варна", note: "Остави на портиера, ако ме няма.",
      status: "confirmed", total: 18.80, slot: "12:00 – 13:00" },
    { id: "1035", time: "06:40", customer: "Стефан Маринов", phone: "+359 87 559 6603",
      items: [{ name: "Мед липов 450 г", qty: 1 }, { name: "Сироп от ягоди 330 мл", qty: 2 }],
      delivery: "Адрес", address: "ул. Македония 33, Варна", note: "",
      status: "delivered", total: 35.50, slot: "09:00 – 10:00" },
    { id: "1034", time: "06:31", customer: "Петя Василева", phone: "+359 88 311 8842",
      items: [{ name: "Ягоди 500 г", qty: 1 }, { name: "Боровинки 250 г", qty: 1 }],
      delivery: "Еконт", address: "Еконт офис — ул. Девня 16", note: "",
      status: "delivered", total: 14.40, slot: "09:00 – 10:00" },
    { id: "1033", time: "06:18", customer: "Тодор Ангелов", phone: "+359 89 740 1126",
      items: [{ name: "Малини 500 г", qty: 2 }],
      delivery: "Адрес", address: "ул. Подвис 7, Варна", note: "",
      status: "delivered", total: 16.40, slot: "09:00 – 10:00" },
    { id: "1032", time: "06:02", customer: "Виолета Петкова", phone: "+359 88 425 5590",
      items: [{ name: "Домашно сладко малина 320 г", qty: 1 }, { name: "Мед липов 450 г", qty: 1 }],
      delivery: "Адрес", address: "ул. Генерал Колев 88, Варна", note: "",
      status: "cancelled", total: 23.40, slot: "—" },
    { id: "1031", time: "05:49", customer: "Красимир Илиев", phone: "+359 87 992 0034",
      items: [{ name: "Череши 1 кг", qty: 1 }],
      delivery: "Адрес", address: "ул. Хан Аспарух 21, Варна", note: "",
      status: "delivered", total: 9.40, slot: "09:00 – 10:00" },
    { id: "1030", time: "05:33", customer: "Десислава Райчева", phone: "+359 88 117 4408",
      items: [{ name: "Ягоди 500 г", qty: 2 }, { name: "Малини 500 г", qty: 1 }],
      delivery: "Еконт", address: "Еконт офис — ул. Цар Освободител 109", note: "",
      status: "confirmed", total: 21.20, slot: "13:00 – 14:00" },
  ];

  // ---- Slots (weekly) ----
  // days Mon-Sun, each with slots {time, booked, capacity}
  const slots = [
    { day: "Понеделник", short: "Пон", date: "25.05", slots: [
      { time: "09:00 – 10:00", booked: 5, cap: 5 },
      { time: "10:00 – 11:00", booked: 2, cap: 5 },
      { time: "11:00 – 12:00", booked: 4, cap: 5 },
      { time: "17:00 – 18:00", booked: 1, cap: 4 },
    ]},
    { day: "Вторник", short: "Вто", date: "26.05", slots: [
      { time: "09:00 – 10:00", booked: 3, cap: 5 },
      { time: "10:00 – 11:00", booked: 5, cap: 5 },
      { time: "17:00 – 18:00", booked: 2, cap: 4 },
    ]},
    { day: "Сряда", short: "Сря", date: "27.05", slots: [
      { time: "10:00 – 11:00", booked: 1, cap: 5 },
      { time: "11:00 – 12:00", booked: 4, cap: 5 },
      { time: "12:00 – 13:00", booked: 3, cap: 5 },
    ]},
    { day: "Четвъртък", short: "Чет", date: "28.05", slots: [
      { time: "09:00 – 10:00", booked: 4, cap: 5 },
      { time: "10:00 – 11:00", booked: 4, cap: 5 },
      { time: "11:00 – 12:00", booked: 5, cap: 5 },
      { time: "17:00 – 18:00", booked: 0, cap: 4 },
    ]},
    { day: "Петък", short: "Пет", date: "29.05", slots: [
      { time: "09:00 – 10:00", booked: 5, cap: 5 },
      { time: "10:00 – 11:00", booked: 3, cap: 5 },
      { time: "12:00 – 13:00", booked: 2, cap: 5 },
    ]},
    { day: "Събота", short: "Съб", date: "30.05", today: true, slots: [
      { time: "09:00 – 10:00", booked: 5, cap: 5 },
      { time: "10:00 – 11:00", booked: 3, cap: 5 },
      { time: "11:00 – 12:00", booked: 4, cap: 5 },
      { time: "12:00 – 13:00", booked: 2, cap: 5 },
      { time: "13:00 – 14:00", booked: 1, cap: 5 },
    ]},
    { day: "Неделя", short: "Нед", date: "31.05", slots: [
      { time: "10:00 – 11:00", booked: 0, cap: 4 },
      { time: "11:00 – 12:00", booked: 1, cap: 4 },
    ]},
  ];

  // ---- Route (today's delivery stops, ordered) ----
  const route = [
    { id: "1038", customer: "Георги Тодоров", phone: "+359 88 174 9920", address: "ул. Княз Борис I 102, Варна", summary: "Ягоди 500 г × 3", slot: "10:00 – 11:00", lat: 28, lng: 32 },
    { id: "1042", customer: "Иван Петров", phone: "+359 88 412 7733", address: "ул. Цар Симеон 12, Варна", summary: "Ягоди × 2, Сироп × 1", slot: "10:00 – 11:00", lat: 40, lng: 24 },
    { id: "1040", customer: "Димитър Иванов", phone: "+359 88 901 6655", address: "бул. Сливница 45, вх. Б", summary: "Малини, Череши, Мед", slot: "10:00 – 11:00", lat: 55, lng: 38 },
    { id: "1039", customer: "Елена Стоянова", phone: "+359 87 220 4418", address: "ул. Драган Цанков 8, Варна", summary: "Дом. сладко малина × 2", slot: "11:00 – 12:00", lat: 62, lng: 58 },
    { id: "1036", customer: "Анна Колева", phone: "+359 88 663 2017", address: "ж.к. Чайка, бл. 24, вх. А", summary: "Череши 1 кг × 2", slot: "12:00 – 13:00", lat: 74, lng: 70 },
  ];

  window.FF = {
    tenant: "Ферма Петрови",
    location: "Варна",
    dateLabel: "събота, 30 май 2026 г.",
    products, orders, slots, route,
    statusMeta: {
      pending:   { label: "Чакаща",    cls: "pending" },
      confirmed: { label: "Потвърдена", cls: "confirmed" },
      delivered: { label: "Доставена",  cls: "delivered" },
      cancelled: { label: "Отказана",   cls: "cancelled" },
    },
    money: (n) => n.toFixed(2).replace(".", ",") + " лв",
  };
})();
