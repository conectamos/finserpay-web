export const COLOMBIA_DEPARTMENT_CITY_OPTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  AMAZONAS: ["Leticia", "Puerto Nariño"],
  ANTIOQUIA: ["Medellin", "Bello", "Itagui", "Envigado", "Rionegro"],
  ARAUCA: ["Arauca", "Arauquita", "Saravena", "Tame"],
  ATLANTICO: ["Barranquilla", "Soledad", "Malambo", "Puerto Colombia", "Sabanalarga"],
  BOGOTA_DC: ["Bogotá"],
  BOLIVAR: ["Cartagena", "Magangue", "Turbaco", "Arjona"],
  BOYACA: ["Tunja", "Duitama", "Sogamoso", "Chiquinquira", "Paipa"],
  CALDAS: ["Manizales", "Villamaria", "Chinchina", "La Dorada"],
  CAQUETA: ["Florencia", "San Vicente del Caguan", "Puerto Rico"],
  CASANARE: ["Yopal", "Aguazul", "Villanueva", "Paz de Ariporo"],
  CAUCA: ["Popayan", "Santander de Quilichao", "Puerto Tejada", "Patia"],
  CESAR: ["Valledupar", "Aguachica", "Agustin Codazzi", "Bosconia"],
  CHOCO: ["Quibdo", "Istmina", "Condoto", "Riosucio"],
  CORDOBA: ["Monteria", "Cerete", "Lorica", "Sahagun", "Montelibano"],
  CUNDINAMARCA: ["Soacha", "Facatativa", "Zipaquira", "Chia", "Fusagasuga"],
  GUAINIA: ["Inirida"],
  GUAVIARE: ["San Jose del Guaviare", "Calamar", "El Retorno", "Miraflores"],
  HUILA: ["Neiva", "Pitalito", "Garzon", "La Plata"],
  LA_GUAJIRA: ["Riohacha", "Maicao", "Uribia", "Manaure", "San Juan del Cesar"],
  MAGDALENA: ["Santa Marta", "Cienaga", "Fundacion", "Plato", "El Banco"],
  META: ["Villavicencio", "Granada", "Acacias", "Puerto Lopez"],
  NARINO: ["Pasto", "Ipiales", "Tumaco", "Tuquerres"],
  NORTE_DE_SANTANDER: ["Cucuta", "Ocana", "Pamplona", "Villa del Rosario", "Los Patios"],
  PUTUMAYO: ["Mocoa", "Puerto Asis", "Orito", "Valle del Guamuez"],
  QUINDIO: ["Armenia", "Calarca", "Montenegro", "Quimbaya"],
  RISARALDA: ["Pereira", "Dosquebradas", "Santa Rosa de Cabal"],
  SAN_ANDRES_PROVIDENCIA_Y_SANTA_CATALINA: ["San Andres", "Providencia"],
  SANTANDER: ["Bucaramanga", "Floridablanca", "Girón", "Piedecuesta", "Barrancabermeja"],
  SUCRE: ["Sincelejo", "Corozal", "Sampues", "Tolu"],
  TOLIMA: ["Ibague", "Espinal", "Melgar", "Honda", "Lerida"],
  VALLE_DEL_CAUCA: ["Cali", "Palmira", "Tulua", "Buenaventura", "Buga"],
  VAUPES: ["Mitu"],
  VICHADA: ["Puerto Carreno", "La Primavera", "Santa Rosalia", "Cumaribo"],
};

export const COLOMBIA_DEPARTMENT_OPTIONS = [
  { value: "AMAZONAS", label: "AMAZONAS" },
  { value: "ANTIOQUIA", label: "ANTIOQUIA" },
  { value: "ARAUCA", label: "ARAUCA" },
  { value: "ATLANTICO", label: "ATLÁNTICO" },
  { value: "BOGOTA_DC", label: "BOGOTÁ, D. C." },
  { value: "BOLIVAR", label: "BOLÍVAR" },
  { value: "BOYACA", label: "BOYACÁ" },
  { value: "CALDAS", label: "CALDAS" },
  { value: "CAQUETA", label: "CAQUETÁ" },
  { value: "CASANARE", label: "CASANARE" },
  { value: "CAUCA", label: "CAUCA" },
  { value: "CESAR", label: "CESAR" },
  { value: "CHOCO", label: "CHOCÓ" },
  { value: "CORDOBA", label: "CÓRDOBA" },
  { value: "CUNDINAMARCA", label: "CUNDINAMARCA" },
  { value: "GUAINIA", label: "GUAINÍA" },
  { value: "GUAVIARE", label: "GUAVIARE" },
  { value: "HUILA", label: "HUILA" },
  { value: "LA_GUAJIRA", label: "LA GUAJIRA" },
  { value: "MAGDALENA", label: "MAGDALENA" },
  { value: "META", label: "META" },
  { value: "NARINO", label: "NARIÑO" },
  { value: "NORTE_DE_SANTANDER", label: "NORTE DE SANTANDER" },
  { value: "PUTUMAYO", label: "PUTUMAYO" },
  { value: "QUINDIO", label: "QUINDÍO" },
  { value: "RISARALDA", label: "RISARALDA" },
  {
    value: "SAN_ANDRES_PROVIDENCIA_Y_SANTA_CATALINA",
    label: "ARCHIPIÉLAGO DE SAN ANDRÉS, PROVIDENCIA Y SANTA CATALINA",
  },
  { value: "SANTANDER", label: "SANTANDER" },
  { value: "SUCRE", label: "SUCRE" },
  { value: "TOLIMA", label: "TOLIMA" },
  { value: "VALLE_DEL_CAUCA", label: "VALLE DEL CAUCA" },
  { value: "VAUPES", label: "VAUPÉS" },
  { value: "VICHADA", label: "VICHADA" },
] as const;

const COLOMBIA_DEPARTMENT_LABELS = new Map<string, string>(
  COLOMBIA_DEPARTMENT_OPTIONS.map(({ value, label }) => [value, label])
);

function normalizeLocation(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

export function getColombiaDepartmentLabel(
  department: string | null | undefined
) {
  const value = String(department || "").trim();

  if (!value) {
    return "";
  }

  return COLOMBIA_DEPARTMENT_LABELS.get(value) || value.replace(/_/g, " ");
}

export function getColombiaCityOptions(
  department: string,
  currentCity = ""
): readonly string[] {
  const configuredCities = [
    ...(COLOMBIA_DEPARTMENT_CITY_OPTIONS[department] || []),
  ];

  // Some historical records stored Bogota as part of Cundinamarca. Keep that
  // saved value selectable while all new records use the independent district.
  if (
    department === "CUNDINAMARCA" &&
    normalizeLocation(currentCity) === "BOGOTA" &&
    !configuredCities.some(
      (city) => normalizeLocation(city) === normalizeLocation(currentCity)
    )
  ) {
    configuredCities.push(currentCity.trim());
  }

  return configuredCities;
}
