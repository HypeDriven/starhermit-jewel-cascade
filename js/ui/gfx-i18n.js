/**
 * gfx-i18n.js — strings for the Graphics settings section in every required
 * locale. The rest of the game ships English only (spec §10); this panel picks
 * its locale from navigator.language.
 */

const en = {
  title: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postNote: 'Post-processing is unavailable on this device, so effects that need it are off.',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: {
    shadows: 'Shadows',
    ao: 'Ambient occlusion',
    bloom: 'Bloom',
    grade: 'Color grade',
    antialias: 'Anti-aliasing',
    reflections: 'Reflections',
    particles: 'Particles',
    background: 'Background motion',
    detail: 'Surface detail',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
  },
  words: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing',
  },
};

const enGB = {
  ...en,
  cats: { ...en.cats, grade: 'Colour grade' },
};

const es = {
  title: 'Gráficos',
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa',
  showFps: 'Mostrar fotogramas por segundo',
  postNote: 'El posprocesado no está disponible en este dispositivo; los efectos que lo necesitan están desactivados.',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras',
    ao: 'Oclusión ambiental',
    bloom: 'Resplandor',
    grade: 'Corrección de color',
    antialias: 'Antialiasing',
    reflections: 'Reflejos',
    particles: 'Partículas',
    background: 'Movimiento del fondo',
    detail: 'Detalle de superficies',
  },
  tiers: {
    off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado',
  },
  words: {
    noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing',
  },
};

const esES = {
  ...es,
  showFps: 'Mostrar FPS',
  renderScale: 'Escala de renderizado',
  tiers: { ...es.tiers, off: 'Desactivado', on: 'Activado' },
};
const es419 = { ...es, tiers: { ...es.tiers, off: 'Desactivado', on: 'Activado' } };

const de = {
  title: 'Grafik',
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  renderScale: 'Renderskalierung',
  fromPreset: 'Laut Voreinstellung ({tier})',
  adaptive: 'Adaptive Auflösung',
  showFps: 'Bildrate anzeigen',
  postNote: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte, die sie benötigen, sind aus.',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: {
    shadows: 'Schatten',
    ao: 'Umgebungsverdeckung',
    bloom: 'Bloom',
    grade: 'Farbkorrektur',
    antialias: 'Kantenglättung',
    reflections: 'Spiegelungen',
    particles: 'Partikel',
    background: 'Hintergrundbewegung',
    detail: 'Oberflächendetails',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert',
  },
  words: {
    noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Bloom', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung',
  },
};

const fr = {
  title: 'Graphismes',
  quality: 'Qualité',
  auto: 'Automatique (détectée : {tier})',
  renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative',
  showFps: 'Afficher la fréquence d’images',
  postNote: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets qui en dépendent sont désactivés.',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombres',
    ao: 'Occlusion ambiante',
    bloom: 'Flou lumineux',
    grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage',
    reflections: 'Reflets',
    particles: 'Particules',
    background: 'Animation du décor',
    detail: 'Détail des surfaces',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Faible', medium: 'Moyen', high: 'Élevé',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
  },
  words: {
    noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
    bloom: 'flou lumineux', reflections: 'reflets', noAA: 'sans anticrénelage',
  },
};
const frCA = {
  ...fr,
  cats: { ...fr.cats, bloom: 'Halo lumineux', background: 'Mouvement de l’arrière-plan' },
  words: { ...fr.words, bloom: 'halo lumineux' },
};

const ptBR = {
  title: 'Gráficos',
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderização',
  fromPreset: 'Conforme a predefinição ({tier})',
  adaptive: 'Resolução adaptativa',
  showFps: 'Mostrar taxa de quadros',
  postNote: 'O pós-processamento não está disponível neste dispositivo; os efeitos que dependem dele estão desativados.',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras',
    ao: 'Oclusão de ambiente',
    bloom: 'Brilho',
    grade: 'Correção de cor',
    antialias: 'Antisserrilhamento',
    reflections: 'Reflexos',
    particles: 'Partículas',
    background: 'Movimento do cenário',
    detail: 'Detalhe das superfícies',
  },
  tiers: {
    off: 'Desativado', on: 'Ativado', low: 'Baixo', medium: 'Médio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
  },
  words: {
    noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
    bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento',
  },
};

const it = {
  title: 'Grafica',
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  renderScale: 'Scala di rendering',
  fromPreset: 'Da preimpostazione ({tier})',
  adaptive: 'Risoluzione adattiva',
  showFps: 'Mostra frequenza fotogrammi',
  postNote: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti che la richiedono sono disattivati.',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombre',
    ao: 'Occlusione ambientale',
    bloom: 'Bagliore',
    grade: 'Correzione colore',
    antialias: 'Antialiasing',
    reflections: 'Riflessi',
    particles: 'Particelle',
    background: 'Movimento dello sfondo',
    detail: 'Dettaglio superfici',
  },
  tiers: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
  },
  words: {
    noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing',
  },
};

export const GFX_STRINGS = {
  'en-US': en,
  'en-GB': enGB,
  'es-419': es419,
  'es-ES': esES,
  'de-DE': de,
  'fr-FR': fr,
  'fr-CA': frCA,
  'pt-BR': ptBR,
  'it-IT': it,
};

/** Best supported locale for a BCP 47 tag (exact, then language fallback). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split('-');
  const r = region.toUpperCase();
  switch (lang) {
    case 'en': return ['GB', 'IE', 'AU', 'NZ', 'IN', 'ZA'].includes(r) ? 'en-GB' : 'en-US';
    case 'es': return r === 'ES' ? 'es-ES' : 'es-419';
    case 'de': return 'de-DE';
    case 'fr': return r === 'CA' ? 'fr-CA' : 'fr-FR';
    case 'pt': return 'pt-BR';
    case 'it': return 'it-IT';
    default: return 'en-US';
  }
}
