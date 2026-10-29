// Client-side localization. Mobile follows the Explorer preference, while
// Bevy desktop uses the player's persisted in-scene choice.

import { getPlayerLanguage, onPlayerLanguageChanged } from '@dcl/sdk/platform'
import { getExplorerInformation } from '~system/Runtime'
import type { LanguagePreference } from '../../shared/types'

export type AppLanguage = LanguagePreference

const LANGUAGE_LABEL: Record<AppLanguage, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese'
}

let currentLanguage: AppLanguage = 'en'
let listening = false
let languageMode: 'pending' | 'mobile' | 'desktop' = 'pending'
let storedLanguage: AppLanguage = 'en'
let platformLanguage: AppLanguage = 'en'
const MOBILE_AGENT_RE = /mobile|android|iphone|ipad|ios/
const languageListeners = new Set<() => void>()

function setCurrentLanguage(language: AppLanguage): void {
  if (currentLanguage === language) return
  currentLanguage = language
  for (const listener of languageListeners) listener()
}

/** Rebuild non-React text (for example 3D pointer prompts) after a locale swap. */
export function onLanguageChanged(listener: () => void): () => void {
  languageListeners.add(listener)
  return () => languageListeners.delete(listener)
}

/** Convert an Explorer BCP-47 tag into one of the languages shipped by the scene. */
export function languageFromTag(tag: string | null | undefined): AppLanguage {
  const normalized = (tag ?? '').toLowerCase()
  if (normalized === 'es' || normalized.startsWith('es-')) return 'es'
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt'
  return 'en'
}

export function getLanguage(): AppLanguage {
  return currentLanguage
}

export function languageName(language = currentLanguage): string {
  return LANGUAGE_LABEL[language]
}

/** True for mobile (and only briefly while platform detection is pending). */
export function usesPlatformLanguage(): boolean {
  return languageMode !== 'desktop'
}

/** Apply the persisted wallet preference received in a server snapshot. */
export function applyStoredLanguage(language: AppLanguage | undefined): void {
  storedLanguage = language === 'es' || language === 'pt' ? language : 'en'
  if (languageMode === 'desktop') setCurrentLanguage(storedLanguage)
}

/** Optimistically update Bevy UI before the authoritative save/snapshot returns. */
export function selectDesktopLanguage(language: AppLanguage): void {
  storedLanguage = language
  if (languageMode !== 'mobile') setCurrentLanguage(language)
}

/** Read mobile Settings now and choose the appropriate language source. */
export function setupLocalization(): void {
  platformLanguage = languageFromTag(getPlayerLanguage())
  setCurrentLanguage(platformLanguage)
  if (listening) return
  listening = true
  onPlayerLanguageChanged.add(({ language }) => {
    platformLanguage = languageFromTag(language)
    if (languageMode !== 'desktop') setCurrentLanguage(platformLanguage)
  })
  void getExplorerInformation({})
    .then((info) => {
      const platform = (info.platform ?? '').toLowerCase()
      const agent = (info.agent ?? '').toLowerCase()
      languageMode = platform === 'mobile' || MOBILE_AGENT_RE.test(agent) ? 'mobile' : 'desktop'
      setCurrentLanguage(languageMode === 'mobile' ? platformLanguage : storedLanguage)
    })
    .catch(() => {
      // If Explorer cannot identify itself, default to the desktop-safe flow:
      // it has a visible picker and never relies on an unavailable setting.
      languageMode = 'desktop'
      setCurrentLanguage(storedLanguage)
    })
}

type Dictionary = Record<string, string>

// These values intentionally use the existing English copy as their lookup key.
// It lets legacy UI, dialogs and authoritative notifications be translated while
// the gameplay code is migrated incrementally to t('namespace.key'). New copy
// should always use t() below.
const ES: Dictionary = {
  'Accept': 'Aceptar',
  'Add': 'Añadir',
  'Adopt': 'Adoptar',
  'Adopt!': '¡Adoptar!',
  'Adopt now!': '¡Adopta ahora!',
  'Adult': 'Adulto',
  'Amazing!': '¡Increíble!',
  'Back': 'Atrás',
  'Bath': 'Baño',
  'Board the Ark?': '¿Subir al Arca?',
  'Breed': 'Criar',
  'Breed!': '¡Criar!',
  'Buy': 'Comprar',
  'Caretaker': 'Cuidador',
  'Captain': 'Capitán',
  'Choose a pet': 'Elige una mascota',
  'Close': 'Cerrar',
  'Coins': 'Monedas',
  'Come back tomorrow!': '¡Vuelve mañana!',
  'Creatures': 'Criaturas',
  'Daily Rewards': 'Recompensas diarias',
  'Decline': 'Rechazar',
  'Energy': 'Energía',
  'Exit': 'Salir',
  'Feed': 'Alimentar',
  'Food': 'Comida',
  'Give a treat': 'Dar un premio',
  'Got it!': '¡Entendido!',
  'Great!': '¡Genial!',
  'Happy': 'Felicidad',
  'Hatch': 'Eclosionar',
  'Hold to throw': 'Mantén y lanza',
  'Hunger': 'Hambre',
  'Hygiene': 'Higiene',
  'Inventory': 'Inventario',
  'Junior': 'Cría',
  'Keep': 'Conservar',
  'Discard': 'Descartar',
  'Jukebox': 'Jukebox',
  'Leaderboard': 'Clasificación',
  'Loading game art...': 'Cargando arte del juego...',
  'Loading standings…': 'Cargando clasificación…',
  'Locked': 'Bloqueado',
  'Mood': 'Ánimo',
  'Move left and right to catch the food falling from the tree!': '¡Muévete a izquierda y derecha para atrapar la comida que cae del árbol!',
  'Mute music': 'Silenciar música',
  'Muted': 'Silenciado',
  'My Pets': 'Mis mascotas',
  'Next': 'Siguiente',
  'No free pet slots. Buy one first.': 'No hay espacios libres. Compra uno primero.',
  'Not Adult': 'No es adulto',
  'Not enough coins': 'No tienes suficientes monedas',
  'Not enough coins!': '¡No tienes suficientes monedas!',
  'Not yet': 'Aún no',
  'Now playing': 'Reproduciendo',
  'OK': 'Aceptar',
  'Pause': 'Pausa',
  'Pet Actions': 'Acciones',
  'Pet Slots': 'Espacios de mascota',
  'Pets sent': 'Mascotas enviadas',
  'Play': 'Jugar',
  'Place Pet': 'Colocar mascota',
  'Player': 'Jugador',
  'Ranking': 'Clasificación',
  'Remove': 'Quitar',
  'Reset': 'Restablecer',
  'Resume': 'Continuar',
  'Select': 'Seleccionar',
  'Selected': 'Seleccionada',
  'Send aboard': 'Enviar a bordo',
  'Send to Ark': 'Enviar al Arca',
  'Shop': 'Tienda',
  'Sleep': 'Dormir',
  'Spin Wheel': 'Ruleta',
  'SPIN!': '¡GIRAR!',
  'Start': 'Empezar',
  'Still connecting to the server…': 'Aún conectando con el servidor…',
  'Tap to adopt': 'Toca para adoptar',
  'Tap to choose': 'Toca para elegir',
  'Tap the egg to hatch!': '¡Toca para eclosionar!',
  'Rub the egg to hatch!': '¡Frota para eclosionar!',
  'Hatching!': '¡Eclosionando!',
  'Teenager': 'Joven',
  'Thank you!': '¡Gracias!',
  'TODAY': 'HOY',
  'Unlock': 'Desbloquear',
  'Unmute music': 'Activar música',
  'Use': 'Usar',
  'Volume': 'Volumen',
  'Wake': 'Despertar',
  'Your Egg': 'Tu huevo',
  'Your pet': 'Tu mascota',

  "I'm hungry, please feed me!": '¡Tengo hambre, por favor dame de comer!',
  'I feel dirty... bath time?': 'Me siento sucio... ¿hora del baño?',
  "I'm sleepy, take me to bed!": '¡Tengo sueño, llévame a la cama!',
  "I'm bored! Let's play together!": '¡Estoy aburrido! ¡Juguemos juntos!',
  'Pet me, I missed you!': '¡Acaríciame, te extrañé!',
  "I'm worn out — I can't play any more. Bed, please!": 'Estoy agotado; ya no puedo jugar. ¡A la cama, por favor!',

  'Happy, healthy pets earn more Coins and XP — and the healthier the pet, the stronger its future offspring.': 'Las mascotas felices y sanas ganan más monedas y XP; cuanto más sana esté, más fuerte será su futura cría.',
  "Breeding is coming soon: raise your pet's level and you'll be able to cross it with other colonists' pets.": 'La cría llegará pronto: sube el nivel de tu mascota y podrás cruzarla con las de otros colonos.',
  'Use the Whistle button to call your pet over or tell it to stay put.': 'Usa el silbato para llamar a tu mascota o pedirle que se quede.',
  'This is a rare LEGENDARY creature — the finest the colony has to offer.': 'Esta es una criatura LEGENDARIA rara: lo mejor que ofrece la colonia.',
  'The secret? Keep your creatures thriving. When all four needs stay full, breeding two of them gives a far greater chance of hatching a LEGENDARY.': '¿El secreto? Mantén a tus criaturas saludables. Cuando sus cuatro necesidades estén llenas, criarlas da muchas más posibilidades de obtener una LEGENDARIA.',
  'Once it grows up, take it to the Captain by the Ark — a Legendary earns the biggest reward when it boards. Be a good caretaker and provide the colony with exceptional creatures.': 'Cuando crezca, llévala al Capitán junto al Arca. Una Legendaria obtiene la mayor recompensa al subir. ¡Cuida bien de la colonia!',
  'Your goal today: raise a creature worth breeding. I will guide you every step of the way.': 'Tu objetivo de hoy: criar una criatura lista para reproducirse. Te guiaré en cada paso.',
  'Tap "Adopt a Pet" to take in your first Martian companion.': 'Toca "Adopt a Pet" para recibir a tu primer compañero marciano.',
  'Keep it thriving: Feed at the Bowl, Bath at the Pond, Sleep on the Bed, Play at the Ball. Tap it anytime for some love.': 'Mantenla feliz: aliméntala en el cuenco, báñala en el estanque, déjala dormir en la cama y juega con la pelota. Tócala para darle cariño.',
  "A healthy, happy pet earns Coins — and soon you'll breed it with other settlers' pets to grow the colony. Let's begin!": 'Una mascota sana y feliz gana monedas. Pronto la criarás con las mascotas de otros colonos para hacer crecer la colonia. ¡Empecemos!',
  "Since it's your first time, I've granted you a Grow Potion.": 'Como es tu primera vez, te he dado una poción de crecimiento.',
  'Go find a mushroom in the woods. One bite and your pet will be all grown up!': 'Busca una seta en el bosque. ¡Un mordisco y tu mascota crecerá por completo!',
  'Look at that: your very first hybrid!': '¡Mira eso: tu primer híbrido!',
  'Babies need lots of care to grow up. Feed it, bathe it and play with it.': 'Las crías necesitan mucho cuidado para crecer. Aliméntala, báñala y juega con ella.',
  "Next time you won't need my pet: adopt a second one, raise both to Adult and breed them yourselves.": 'La próxima vez no necesitarás mi mascota: adopta una segunda, lleva ambas a Adulto y críalas tú mismo.',
  'Come back tomorrow: your daily streak reward will be waiting!': 'Vuelve mañana: ¡tu recompensa de racha diaria te estará esperando!',
  'One last thing: the Captain is waiting for you at the Ark. Go say hello!': 'Una última cosa: el Capitán te espera en el Arca. ¡Ve a saludarlo!',
  'That mushroom is for your first pet. Pick it in My Pets first!': 'Esa seta es para tu primera mascota. ¡Primero elígela en Mis mascotas!',
  'Try breeding before adopting: a bred creature gets you more XP!': '¡Prueba criar antes de adoptar: una criatura criada te da más XP!',
  'Look how big it is! Now it is ready for the best part: breeding.': '¡Mira cuánto creció! Ahora está lista para la mejor parte: criar.',
  'The baby will need a home of its own, so unlock one more slot in My Pets first.': 'La cría necesitará su propio hogar, así que primero desbloquea un espacio más en Mis mascotas.',
  'Take it home and hatch it! Walk back to your house, then tap Hatch.': '¡Llévalo a casa y hazlo eclosionar! Vuelve a tu casa y toca Eclosionar.',
  'Bring me an Adult pet and it will board the Ark. Rarer pets earn you more XP and coins — and your very first donation earns you the Caretaker Head wearable!': 'Tráeme una mascota Adulta y subirá al Arca. Las más raras dan más XP y monedas; ¡tu primera donación te da el wearable Cabeza de Cuidador!',
  'Keep breeding to discover amazing creatures, climb the leaderboard and get more wearables!': '¡Sigue criando para descubrir criaturas increíbles, subir en la clasificación y conseguir más wearables!',
  'Your pet is hungry! Tap Pet Actions and choose Feed.': '¡Tu mascota tiene hambre! Toca Acciones y elige Alimentar.',
  "It's covered in mud from the chase! Tap Pet Actions and choose Bath.": '¡Está cubierta de barro por la persecución! Toca Acciones y elige Baño.',
  "It's feeling better. Let's play! Tap Pet Actions and choose Play.": 'Se siente mejor. ¡Juguemos! Toca Acciones y elige Jugar.',
  'Find the mushroom in the woods and tap it. Your pet will grow up!': 'Busca la seta en el bosque y tócala. ¡Tu mascota crecerá!',
  'Tap Pet Actions and choose Breed, then carry it to the breeding nest in the house.': 'Toca Acciones y elige Criar; luego llévala al nido de cría de la casa.',
  'Go talk to the Captain at the Ark. He has a mission for the whole colony!': 'Ve a hablar con el Capitán en el Arca. ¡Tiene una misión para toda la colonia!',
  'Oh no — your pet ate a poisonous fruit and feels really bad.': '¡Oh no! Tu mascota comió una fruta venenosa y se siente muy mal.',
  "Don't worry. Come find me at the Care Center — I have the cure ready.": 'No te preocupes. Ven a buscarme al Centro de cuidados: tengo la cura lista.',
  'You made it. Stay close — I will unlock the medicine for your little one.': 'Llegaste. Quédate cerca: desbloquearé la medicina para tu pequeño.',
  'There, the cage is open. This cure will make them feel much better now.': 'Listo, la jaula está abierta. Esta cura lo hará sentir mucho mejor.',
  'And take some coins for your bravery. You will need them soon!': 'Y toma algunas monedas por tu valentía. ¡Las necesitarás pronto!',
  'That Pepito stole your cure! Look — it is circling above the Care Center with it.': '¡Ese Pepito robó tu cura! Mira: está dando vueltas sobre el Centro de cuidados.',
  'Use a rock to knock it down. Hit Pepito and it will drop the medicine!': 'Usa una roca para derribarlo. ¡Golpea a Pepito y soltará la medicina!',
  "Let's go!": '¡Vamos!',

  'Your pet is busy — wait a moment!': 'Tu mascota está ocupada; espera un momento.',
  'Your pet is asleep!': '¡Tu mascota está dormida!',
  'Your pet is busy right now!': '¡Tu mascota está ocupada ahora!',
  'Adopt a pet first!': '¡Primero adopta una mascota!',
  'Finish what your pet is doing first!': '¡Primero termina lo que está haciendo tu mascota!',
  "Follow the Caretaker's instructions first!": '¡Sigue primero las instrucciones del Cuidador!',
  'Only Adult pets can board the Ark.': 'Solo las mascotas adultas pueden subir al Arca.',
  'Take your egg home first!': '¡Primero lleva tu huevo a casa!',
  'Bath cancelled': 'Baño cancelado',
  'Adoption cancelled': 'Adopción cancelada',
  'Direct hit!': '¡Impacto directo!',
  'Go get the cure on the ground!': '¡Ve a buscar la cura al suelo!',
  'Pepito stole the cure!': '¡Pepito robó la cura!',
  'Place or discard your current pet first.': 'Primero coloca o descarta a tu mascota actual.',
  'Go to the Caretaker to pick up your egg first!': '¡Ve primero con el Cuidador a buscar tu huevo!',
  'No active pet': 'No hay una mascota activa',
  'No free pet slots': 'No hay espacios libres para mascotas',
  'Pet is still busy...': 'La mascota sigue ocupada...',
  'Unknown species': 'Especie desconocida',
  'No such item': 'No existe ese objeto',
  'No spin tickets': 'No tienes boletos para girar',
  'Daily reward already claimed today.': 'La recompensa diaria ya fue reclamada hoy.',
  'Your pet is hungry! Click your pet and choose Feed.': '¡Tu mascota tiene hambre! Haz clic en tu mascota y elige Alimentar.',
  "It's covered in mud from the chase! Click your pet and choose Bath.": '¡Está cubierta de barro por la persecución! Haz clic en tu mascota y elige Baño.',
  "It's feeling better. Let's play! Click your pet and choose Play.": 'Se siente mejor. ¡Juguemos! Haz clic en tu mascota y elige Jugar.',
  'Click your pet and choose Breed, then carry it to the breeding nest in the house.': 'Haz clic en tu mascota y elige Criar; luego llévala al nido de cría de la casa.',
  "It's still asleep. Click your pet and wake it up.": 'Todavía está dormida. Haz clic en tu mascota y despiértala.',
  'Open My Pets and unlock one more slot for the baby.': 'Abre Mis mascotas y desbloquea un espacio más para la cría.',
  'Talk to the Caretaker to get your first pet!': '¡Habla con el Cuidador para conseguir tu primera mascota!',
  'You are home! Press Hatch to hatch your egg.': '¡Ya estás en casa! Pulsa Eclosionar para abrir tu huevo.',
  'Follow the green arrow to the tree to feed your pet!': '¡Sigue la flecha verde hasta el árbol para alimentar a tu mascota!',
  'Take your sick pet to the Caretaker at the Care Center!': '¡Lleva a tu mascota enferma al Cuidador en el Centro de cuidados!',
  'Take your egg home to hatch it!': '¡Lleva tu huevo a casa para eclosionarlo!',
  'Carry your pet to the bath!': '¡Lleva a tu mascota al baño!',
  'Carry your pet to the breeding nest!': '¡Lleva a tu mascota al nido de cría!',
  'Go to the Caretaker to pick up your egg!': '¡Ve al Cuidador a buscar tu huevo!',
  'Follow the green arrow to your next objective!': '¡Sigue la flecha verde hasta tu siguiente objetivo!',
  'Walk your pet to the Captain at the Ark!': '¡Lleva a tu mascota al Capitán en el Arca!',
}

const PT: Dictionary = {
  'Accept': 'Aceitar',
  'Add': 'Adicionar',
  'Adopt': 'Adotar',
  'Adopt!': 'Adotar!',
  'Adopt now!': 'Adote agora!',
  'Adult': 'Adulto',
  'Back': 'Voltar',
  'Bath': 'Banho',
  'Board the Ark?': 'Embarcar na Arca?',
  'Breed': 'Cruzar',
  'Breed!': 'Cruzar!',
  'Buy': 'Comprar',
  'Caretaker': 'Cuidador',
  'Captain': 'Capitão',
  'Choose a pet': 'Escolha um pet',
  'Close': 'Fechar',
  'Coins': 'Moedas',
  'Daily Rewards': 'Recompensas diárias',
  'Decline': 'Recusar',
  'Energy': 'Energia',
  'Exit': 'Sair',
  'Feed': 'Alimentar',
  'Food': 'Comida',
  'Give a treat': 'Dar um petisco',
  'Got it!': 'Entendi!',
  'Great!': 'Ótimo!',
  'Happy': 'Felicidade',
  'Hatch': 'Chocar',
  'Hold to throw': 'Segure e lance',
  'Hunger': 'Fome',
  'Hygiene': 'Higiene',
  'Inventory': 'Inventário',
  'Junior': 'Filhote',
  'Keep': 'Ficar',
  'Discard': 'Descartar',
  'Jukebox': 'Jukebox',
  'Leaderboard': 'Classificação',
  'Loading game art...': 'Carregando arte do jogo...',
  'Loading standings…': 'Carregando classificação…',
  'Locked': 'Bloqueado',
  'Mood': 'Humor',
  'Move left and right to catch the food falling from the tree!': 'Mova-se para a esquerda e direita para pegar a comida que cai da árvore!',
  'Mute music': 'Silenciar música',
  'Muted': 'Sem som',
  'My Pets': 'Meus pets',
  'Next': 'Próximo',
  'No free pet slots. Buy one first.': 'Não há vagas livres. Compre uma primeiro.',
  'Not Adult': 'Não é adulto',
  'Not enough coins': 'Moedas insuficientes',
  'Not enough coins!': 'Moedas insuficientes!',
  'Not yet': 'Ainda não',
  'Now playing': 'Tocando agora',
  'OK': 'OK',
  'Pause': 'Pausar',
  'Pet Actions': 'Ações do pet',
  'Pet Slots': 'Vagas de pet',
  'Pets sent': 'Pets enviados',
  'Play': 'Brincar',
  'Place Pet': 'Colocar pet',
  'Player': 'Jogador',
  'Ranking': 'Classificação',
  'Remove': 'Remover',
  'Reset': 'Redefinir',
  'Resume': 'Continuar',
  'Selected': 'Selecionado',
  'Send aboard': 'Enviar a bordo',
  'Send to Ark': 'Enviar para a Arca',
  'Shop': 'Loja',
  'Sleep': 'Dormir',
  'Spin Wheel': 'Roda da sorte',
  'SPIN!': 'GIRAR!',
  'Start': 'Começar',
  'Still connecting to the server…': 'Ainda conectando ao servidor…',
  'Tap to adopt': 'Toque para adotar',
  'Tap to choose': 'Toque para escolher',
  'Tap the egg to hatch!': 'Toque para chocar!',
  'Rub the egg to hatch!': 'Esfregue para chocar!',
  'Hatching!': 'Chocando!',
  'Teenager': 'Jovem',
  'Thank you!': 'Obrigado!',
  'TODAY': 'HOJE',
  'Unlock': 'Desbloquear',
  'Unmute music': 'Ativar música',
  'Use': 'Usar',
  'Volume': 'Volume',
  'Wake': 'Acordar',
  'Your Egg': 'Seu ovo',
  'Your pet': 'Seu pet',

  "I'm hungry, please feed me!": 'Estou com fome, por favor me alimente!',
  'I feel dirty... bath time?': 'Estou sujo... hora do banho?',
  "I'm sleepy, take me to bed!": 'Estou com sono, leve-me para a cama!',
  "I'm bored! Let's play together!": 'Estou entediado! Vamos brincar juntos!',
  'Pet me, I missed you!': 'Faça carinho em mim, senti sua falta!',
  "I'm worn out — I can't play any more. Bed, please!": 'Estou exausto; não consigo mais brincar. Cama, por favor!',

  'Happy, healthy pets earn more Coins and XP — and the healthier the pet, the stronger its future offspring.': 'Pets felizes e saudáveis ganham mais moedas e XP; quanto mais saudável, mais forte será sua futura cria.',
  "Breeding is coming soon: raise your pet's level and you'll be able to cross it with other colonists' pets.": 'A criação chegará em breve: aumente o nível do seu pet e você poderá cruzá-lo com pets de outros colonos.',
  'Use the Whistle button to call your pet over or tell it to stay put.': 'Use o apito para chamar seu pet ou pedir que ele fique.',
  'This is a rare LEGENDARY creature — the finest the colony has to offer.': 'Esta é uma criatura LENDÁRIA rara: o melhor que a colônia tem a oferecer.',
  'The secret? Keep your creatures thriving. When all four needs stay full, breeding two of them gives a far greater chance of hatching a LEGENDARY.': 'O segredo? Mantenha suas criaturas saudáveis. Quando as quatro necessidades estão cheias, cruzá-las aumenta muito a chance de nascer uma LENDÁRIA.',
  'Once it grows up, take it to the Captain by the Ark — a Legendary earns the biggest reward when it boards. Be a good caretaker and provide the colony with exceptional creatures.': 'Quando crescer, leve-a ao Capitão junto à Arca. Uma Lendária ganha a maior recompensa ao embarcar. Cuide bem da colônia!',
  'Your goal today: raise a creature worth breeding. I will guide you every step of the way.': 'Seu objetivo hoje: criar uma criatura pronta para cruzar. Vou guiar você em cada etapa.',
  'Tap "Adopt a Pet" to take in your first Martian companion.': 'Toque em "Adopt a Pet" para receber seu primeiro companheiro marciano.',
  'Keep it thriving: Feed at the Bowl, Bath at the Pond, Sleep on the Bed, Play at the Ball. Tap it anytime for some love.': 'Mantenha-o feliz: alimente no pote, dê banho na lagoa, deixe-o dormir na cama e brinque com a bola. Toque nele para dar carinho.',
  "A healthy, happy pet earns Coins — and soon you'll breed it with other settlers' pets to grow the colony. Let's begin!": 'Um pet saudável e feliz ganha moedas. Em breve, cruze-o com pets de outros colonos para fazer a colônia crescer. Vamos começar!',
  "Since it's your first time, I've granted you a Grow Potion.": 'Como é sua primeira vez, concedi uma Poção de Crescimento.',
  'Go find a mushroom in the woods. One bite and your pet will be all grown up!': 'Vá encontrar um cogumelo na floresta. Uma mordida e seu pet crescerá por completo!',
  'Look at that: your very first hybrid!': 'Veja só: seu primeiro híbrido!',
  'Babies need lots of care to grow up. Feed it, bathe it and play with it.': 'Filhotes precisam de muito cuidado para crescer. Alimente, dê banho e brinque com ele.',
  "Next time you won't need my pet: adopt a second one, raise both to Adult and breed them yourselves.": 'Da próxima vez você não precisará do meu pet: adote um segundo, leve ambos a Adulto e cruze-os.',
  'Come back tomorrow: your daily streak reward will be waiting!': 'Volte amanhã: sua recompensa de sequência diária estará esperando!',
  'One last thing: the Captain is waiting for you at the Ark. Go say hello!': 'Uma última coisa: o Capitão está esperando por você na Arca. Vá dizer olá!',
  'That mushroom is for your first pet. Pick it in My Pets first!': 'Esse cogumelo é para seu primeiro pet. Escolha-o primeiro em Meus pets!',
  'Try breeding before adopting: a bred creature gets you more XP!': 'Tente cruzar antes de adotar: uma criatura cruzada dá mais XP!',
  'Look how big it is! Now it is ready for the best part: breeding.': 'Veja como cresceu! Agora está pronto para a melhor parte: cruzar.',
  'Take it home and hatch it! Walk back to your house, then tap Hatch.': 'Leve-o para casa e choque-o! Volte para sua casa e toque em Chocar.',
  'Bring me an Adult pet and it will board the Ark. Rarer pets earn you more XP and coins — and your very first donation earns you the Caretaker Head wearable!': 'Traga um pet Adulto e ele embarcará na Arca. Pets mais raros rendem mais XP e moedas; sua primeira doação dá o wearable Cabeça de Cuidador!',
  'Keep breeding to discover amazing creatures, climb the leaderboard and get more wearables!': 'Continue cruzando para descobrir criaturas incríveis, subir no ranking e conseguir mais wearables!',
  'Your pet is hungry! Tap Pet Actions and choose Feed.': 'Seu pet está com fome! Toque em Ações do pet e escolha Alimentar.',
  "It's covered in mud from the chase! Tap Pet Actions and choose Bath.": 'Está coberto de lama da perseguição! Toque em Ações do pet e escolha Banho.',
  "It's feeling better. Let's play! Tap Pet Actions and choose Play.": 'Ele está melhor. Vamos brincar! Toque em Ações do pet e escolha Brincar.',
  'Find the mushroom in the woods and tap it. Your pet will grow up!': 'Encontre o cogumelo na floresta e toque nele. Seu pet crescerá!',
  'Tap Pet Actions and choose Breed, then carry it to the breeding nest in the house.': 'Toque em Ações do pet e escolha Cruzar; depois leve-o ao ninho de criação na casa.',
  'Go talk to the Captain at the Ark. He has a mission for the whole colony!': 'Vá falar com o Capitão na Arca. Ele tem uma missão para toda a colônia!',
  'The baby will need a home of its own, so unlock one more slot in My Pets first.': 'O filhote precisará de um lar, então desbloqueie mais uma vaga em Meus pets primeiro.',
  'Oh no — your pet ate a poisonous fruit and feels really bad.': 'Ah não! Seu pet comeu uma fruta venenosa e está muito mal.',
  "Don't worry. Come find me at the Care Center — I have the cure ready.": 'Não se preocupe. Venha me encontrar no Centro de cuidados: a cura está pronta.',
  'You made it. Stay close — I will unlock the medicine for your little one.': 'Você chegou. Fique perto: vou liberar o remédio para seu pequeno.',
  'There, the cage is open. This cure will make them feel much better now.': 'Pronto, a gaiola está aberta. Esta cura vai fazê-lo se sentir muito melhor.',
  'And take some coins for your bravery. You will need them soon!': 'E leve algumas moedas por sua coragem. Você precisará delas em breve!',
  'That Pepito stole your cure! Look — it is circling above the Care Center with it.': 'Aquele Pepito roubou sua cura! Olhe: ele está circulando sobre o Centro de cuidados.',
  'Use a rock to knock it down. Hit Pepito and it will drop the medicine!': 'Use uma pedra para derrubá-lo. Acerte Pepito e ele soltará o remédio!',
  "Let's go!": 'Vamos!',

  'Your pet is busy — wait a moment!': 'Seu pet está ocupado; espere um momento.',
  'Your pet is asleep!': 'Seu pet está dormindo!',
  'Your pet is busy right now!': 'Seu pet está ocupado agora!',
  'Adopt a pet first!': 'Adote um pet primeiro!',
  'Finish what your pet is doing first!': 'Termine primeiro o que seu pet está fazendo!',
  "Follow the Caretaker's instructions first!": 'Siga primeiro as instruções do Cuidador!',
  'Only Adult pets can board the Ark.': 'Somente pets adultos podem embarcar na Arca.',
  'Take your egg home first!': 'Leve seu ovo para casa primeiro!',
  'Bath cancelled': 'Banho cancelado',
  'Adoption cancelled': 'Adoção cancelada',
  'Direct hit!': 'Acerto direto!',
  'Go get the cure on the ground!': 'Vá buscar a cura no chão!',
  'Pepito stole the cure!': 'Pepito roubou a cura!',
  'Place or discard your current pet first.': 'Primeiro coloque ou descarte seu pet atual.',
  'Go to the Caretaker to pick up your egg first!': 'Vá primeiro ao Cuidador buscar seu ovo!',
  'No active pet': 'Nenhum pet ativo',
  'No free pet slots': 'Não há vagas livres para pets',
  'Pet is still busy...': 'O pet ainda está ocupado...',
  'Unknown species': 'Espécie desconhecida',
  'No such item': 'Esse item não existe',
  'No spin tickets': 'Sem bilhetes para girar',
  'Daily reward already claimed today.': 'A recompensa diária já foi resgatada hoje.',
  'Your pet is hungry! Click your pet and choose Feed.': 'Seu pet está com fome! Clique no seu pet e escolha Alimentar.',
  "It's covered in mud from the chase! Click your pet and choose Bath.": 'Está coberto de lama da perseguição! Clique no seu pet e escolha Banho.',
  "It's feeling better. Let's play! Click your pet and choose Play.": 'Ele está melhor. Vamos brincar! Clique no seu pet e escolha Brincar.',
  'Click your pet and choose Breed, then carry it to the breeding nest in the house.': 'Clique no seu pet e escolha Cruzar; depois leve-o ao ninho de criação na casa.',
  "It's still asleep. Click your pet and wake it up.": 'Ele ainda está dormindo. Clique no seu pet para acordá-lo.',
  'Open My Pets and unlock one more slot for the baby.': 'Abra Meus pets e desbloqueie mais uma vaga para o filhote.',
  'Talk to the Caretaker to get your first pet!': 'Fale com o Cuidador para conseguir seu primeiro pet!',
  'You are home! Press Hatch to hatch your egg.': 'Você está em casa! Pressione Chocar para abrir seu ovo.',
  'Follow the green arrow to the tree to feed your pet!': 'Siga a seta verde até a árvore para alimentar seu pet!',
  'Take your sick pet to the Caretaker at the Care Center!': 'Leve seu pet doente ao Cuidador no Centro de cuidados!',
  'Take your egg home to hatch it!': 'Leve seu ovo para casa para chocá-lo!',
  'Carry your pet to the bath!': 'Leve seu pet para o banho!',
  'Carry your pet to the breeding nest!': 'Leve seu pet ao ninho de criação!',
  'Go to the Caretaker to pick up your egg!': 'Vá ao Cuidador buscar seu ovo!',
  'Follow the green arrow to your next objective!': 'Siga a seta verde até seu próximo objetivo!',
  'Walk your pet to the Captain at the Ark!': 'Leve seu pet ao Capitão na Arca!',
}

const LEGACY: Record<AppLanguage, Dictionary> = { en: {}, es: ES, pt: PT }

// Gameplay toasts originate in both the client and the authoritative server.
// Keep their fixed copy here so the renderer can localize either source in one
// place (including a toast that arrives after a live language change).
const TOAST_FIXED: Record<AppLanguage, Dictionary> = {
  en: {},
  es: {
    'Head to the tree — follow the green arrow!': 'Ve al árbol: ¡sigue la flecha verde!',
    'Visit the Caretaker at the Care Center to adopt a new companion!': '¡Visita al Cuidador en el Centro de cuidados para adoptar un nuevo compañero!',
    'The Captain could not take your pet — please try again.': 'El Capitán no pudo recibir a tu mascota. Inténtalo de nuevo.',
    'The medicine was lost. Speak to the Caretaker and try again.': 'La medicina se perdió. Habla con el Cuidador e inténtalo de nuevo.',
    'The cure scene was interrupted. Speak to the Caretaker and try again.': 'La escena de la cura se interrumpió. Habla con el Cuidador e inténtalo de nuevo.',
    'Aim at Pepito and throw a rock to bring the cure down.': 'Apunta a Pepito y lánzale una piedra para bajar la cura.',
    'Keep or discard your new pet first!': '¡Primero conserva o descarta a tu nueva mascota!',
    'Your pet loved that!  +Happy': '¡A tu mascota le encantó! +Felicidad',
    'Grow your pet to Adult to unlock breeding!': 'Haz crecer a tu mascota hasta Adulto para desbloquear la cría.',
    'You need a second Adult pet to breed with.': 'Necesitas una segunda mascota Adulta para criar.',
    'No free pet slots for the offspring — buy one first.': 'No hay espacios libres para la cría. Compra uno primero.',
    'Both pets must be Adult to breed.': 'Ambas mascotas deben ser Adultas para criar.',
    'Breeding failed — try again.': 'La cría falló. Inténtalo de nuevo.',
    'Your pet is asleep — wake it first.': 'Tu mascota está dormida. Despiértala primero.',
    'Finish the tree errand or tap BACK first!': 'Termina la misión del árbol o toca ATRÁS primero.',
    'Still settling down from the last treat...': 'Aún se está acomodando después del último premio...',
    'Select one of your pets first to offer it.': 'Primero elige una de tus mascotas para ofrecer.',
    'Go see the Caretaker or tap BACK first!': '¡Ve con el Cuidador o toca ATRÁS primero!',
    'Talk to the Captain': 'Hablar con el Capitán',
    'Talk to Caretaker': 'Hablar con el Cuidador',
    'Examine': 'Examinar',
    'Pick the mushroom': 'Recoger la seta',
    'Explore': 'Explorar',
    'Open': 'Abrir',
    'View': 'Ver',
    'Rarity Potions are used when breeding': 'Las pociones de rareza se usan al criar.',
    'Nothing to keep': 'No hay nada que conservar',
    'Pick a different pet to breed with': 'Elige otra mascota para criar',
    'Both pets must be Adult to breed': 'Ambas mascotas deben ser Adultas para criar',
    'Place or discard your current egg first': 'Primero coloca o descarta tu huevo actual',
    'No free pet slots for the offspring': 'No hay espacios libres para la cría',
    'Start a Feed round at the tree first.': 'Primero inicia una ronda de Alimentar en el árbol.',
    'That Feed round expired. Please start again at the tree.': 'Esa ronda de Alimentar expiró. Empieza de nuevo en el árbol.',
    'Finish the Feed round before collecting its result.': 'Termina la ronda de Alimentar antes de recoger el resultado.',
    'Visit the Caretaker before curing your pet.': 'Visita al Cuidador antes de curar a tu mascota.',
    'The cure setup expired. Please see the Caretaker again.': 'La preparación de la cura expiró. Vuelve a ver al Cuidador.',
    'The cure is not ready yet.': 'La cura aún no está lista.',
    'That player has no pet': 'Ese jugador no tiene mascota',
    'Daily treats for this pet reached': 'Ya alcanzaste el límite diario de premios para esta mascota',
    "You can't swap with yourself": 'No puedes intercambiar contigo mismo',
    'Finish with your new pet before offering a swap.': 'Termina con tu nueva mascota antes de ofrecer un intercambio.',
    'Select one of your pets to offer first': 'Primero elige una de tus mascotas para ofrecer',
    'That player has no pet to swap': 'Ese jugador no tiene mascota para intercambiar',
    'That player is reviewing another offer — try again shortly': 'Ese jugador está revisando otra oferta. Inténtalo en un momento.',
    'No pending swap offer': 'No hay una oferta de intercambio pendiente',
    'Swap declined.': 'Intercambio rechazado.',
    'Your swap offer was declined.': 'Tu oferta de intercambio fue rechazada.',
    'That player is no longer around': 'Ese jugador ya no está cerca',
    'The swap fell through — a pet was no longer available': 'El intercambio no se pudo completar porque una mascota ya no estaba disponible',
    'The swap fell through — a pet was no longer available.': 'El intercambio no se pudo completar porque una mascota ya no estaba disponible.',
    'You have none of that item': 'No tienes ese objeto',
    'Switched active pet': 'Cambiaste la mascota activa',
    'Finish with your new pet first.': 'Primero termina con tu nueva mascota.',
    'That pet is no longer in your roster.': 'Esa mascota ya no está en tu lista.',
    'Talk to the Captain at the Ark to donate a pet.': 'Habla con el Capitán en el Arca para donar una mascota.',
    'One moment...': 'Un momento...',
    "Today's meteor is already collected.": 'El meteorito de hoy ya fue recogido.'
  },
  pt: {
    'Head to the tree — follow the green arrow!': 'Vá até a árvore — siga a seta verde!',
    'Visit the Caretaker at the Care Center to adopt a new companion!': 'Visite o Cuidador no Centro de cuidados para adotar um novo companheiro!',
    'The Captain could not take your pet — please try again.': 'O Capitão não conseguiu receber seu pet. Tente de novo.',
    'The medicine was lost. Speak to the Caretaker and try again.': 'O remédio foi perdido. Fale com o Cuidador e tente de novo.',
    'The cure scene was interrupted. Speak to the Caretaker and try again.': 'A cena da cura foi interrompida. Fale com o Cuidador e tente de novo.',
    'Aim at Pepito and throw a rock to bring the cure down.': 'Mire em Pepito e jogue uma pedra para derrubar a cura.',
    'Keep or discard your new pet first!': 'Primeiro fique com ou descarte seu novo pet!',
    'Your pet loved that!  +Happy': 'Seu pet adorou isso! +Felicidade',
    'Grow your pet to Adult to unlock breeding!': 'Faça seu pet crescer até Adulto para liberar a criação.',
    'You need a second Adult pet to breed with.': 'Você precisa de um segundo pet Adulto para cruzar.',
    'No free pet slots for the offspring — buy one first.': 'Não há vagas livres para o filhote. Compre uma primeiro.',
    'Both pets must be Adult to breed.': 'Os dois pets precisam ser Adultos para cruzar.',
    'Breeding failed — try again.': 'A criação falhou. Tente de novo.',
    'Your pet is asleep — wake it first.': 'Seu pet está dormindo. Acorde-o primeiro.',
    'Finish the tree errand or tap BACK first!': 'Termine a missão da árvore ou toque em VOLTAR primeiro!',
    'Still settling down from the last treat...': 'Ainda se recuperando do último petisco...',
    'Select one of your pets first to offer it.': 'Escolha primeiro um dos seus pets para oferecer.',
    'Go see the Caretaker or tap BACK first!': 'Vá ver o Cuidador ou toque em VOLTAR primeiro!',
    'Talk to the Captain': 'Falar com o Capitão',
    'Talk to Caretaker': 'Falar com o Cuidador',
    'Examine': 'Examinar',
    'Pick the mushroom': 'Pegar o cogumelo',
    'Explore': 'Explorar',
    'Open': 'Abrir',
    'View': 'Ver',
    'Rarity Potions are used when breeding': 'Poções de raridade são usadas na criação.',
    'Nothing to keep': 'Não há nada para ficar',
    'Pick a different pet to breed with': 'Escolha outro pet para cruzar',
    'Both pets must be Adult to breed': 'Os dois pets precisam ser Adultos para cruzar',
    'Place or discard your current egg first': 'Primeiro coloque ou descarte seu ovo atual',
    'No free pet slots for the offspring': 'Não há vagas livres para o filhote',
    'Start a Feed round at the tree first.': 'Comece primeiro uma rodada de Alimentar na árvore.',
    'That Feed round expired. Please start again at the tree.': 'Essa rodada de Alimentar expirou. Comece de novo na árvore.',
    'Finish the Feed round before collecting its result.': 'Termine a rodada de Alimentar antes de pegar o resultado.',
    'Visit the Caretaker before curing your pet.': 'Visite o Cuidador antes de curar seu pet.',
    'The cure setup expired. Please see the Caretaker again.': 'A preparação da cura expirou. Fale com o Cuidador novamente.',
    'The cure is not ready yet.': 'A cura ainda não está pronta.',
    'That player has no pet': 'Esse jogador não tem pet',
    'Daily treats for this pet reached': 'O limite diário de petiscos para este pet foi atingido',
    "You can't swap with yourself": 'Você não pode trocar consigo mesmo',
    'Finish with your new pet before offering a swap.': 'Termine com seu novo pet antes de oferecer uma troca.',
    'Select one of your pets to offer first': 'Escolha primeiro um dos seus pets para oferecer',
    'That player has no pet to swap': 'Esse jogador não tem pet para trocar',
    'That player is reviewing another offer — try again shortly': 'Esse jogador está analisando outra oferta. Tente novamente em breve.',
    'No pending swap offer': 'Não há uma oferta de troca pendente',
    'Swap declined.': 'Troca recusada.',
    'Your swap offer was declined.': 'Sua oferta de troca foi recusada.',
    'That player is no longer around': 'Esse jogador não está mais por perto',
    'The swap fell through — a pet was no longer available': 'A troca não foi concluída porque um pet não estava mais disponível',
    'The swap fell through — a pet was no longer available.': 'A troca não foi concluída porque um pet não estava mais disponível.',
    'You have none of that item': 'Você não tem esse item',
    'Switched active pet': 'Você trocou o pet ativo',
    'Finish with your new pet first.': 'Termine primeiro com seu novo pet.',
    'That pet is no longer in your roster.': 'Esse pet não está mais na sua lista.',
    'Talk to the Captain at the Ark to donate a pet.': 'Fale com o Capitão na Arca para doar um pet.',
    'One moment...': 'Um momento...',
    "Today's meteor is already collected.": 'O meteoro de hoje já foi coletado.'
  }
}

/** Translate fixed legacy copy. Unknown content deliberately falls back to English. */
export function translateText(text: string): string {
  if (currentLanguage === 'en' || !text) return text
  const fixed = LEGACY[currentLanguage][text] ?? TOAST_FIXED[currentLanguage][text]
  if (fixed) return fixed
  const term = localizeToastTerm(text, currentLanguage)
  return term === text ? translateDynamic(text, currentLanguage) : term
}

/** New code uses named keys and supports lightweight {variable} interpolation. */
const COPY: Record<AppLanguage, Dictionary> = {
  en: {
    'tutorial.chapter': 'CHAPTER {current}/{total}',
    'language.notice.title': 'Language',
    'language.notice.body': 'Your Decentraland app language is {language}. To change it, go to Profile > Settings > Language > Select language.',
    'language.notice.close': 'Close',
    'language.picker.title': 'Choose language',
    'language.picker.body': 'Choose the language for Marsh Colony. This choice is saved to your account.',
    'language.picker.close': 'Close',
    'language.select': 'SELECT',
    'language.cancel': 'CANCEL',
    'panel.adoptChoose.title': 'Choose a Pet',
    'panel.adoptChoose.subtitle': 'Pick a companion for your colony.',
    'panel.adoptName.title': 'Name Your Pet',
    'panel.adoptName.subtitle': 'Give your new companion a name.',
    'panel.breedName.title': 'Name Your Offspring',
    'panel.breedName.subtitle': 'A potion improves rare chances.',
    'panel.inventory.title': 'Inventory',
    'panel.inventory.subtitle': 'Supplies for your pets.',
    'panel.myPets.title': 'My Pets',
    'panel.myPets.subtitle': 'Your colony companions.',
    'panel.goals.title': 'Your Journey',
    'panel.goals.subtitle': 'Complete steps, earn rewards.',
    'panel.goals.rewardSpin': '{coins} + spin',
    'panel.goals.rewardWearable': 'Wearable',
    'panel.goals.step.adopt': 'Adopt',
    'panel.goals.step.feed': 'Feed',
    'panel.goals.step.bath': 'Bath',
    'panel.goals.step.breed': 'Breed',
    'panel.goals.step.ark': 'Ark',
    'panel.jukebox.title': 'Jukebox',
    'panel.jukebox.subtitle': 'Music for your colony.',
    'panel.choosePartner.title': 'Choose a Partner',
    'panel.choosePartner.subtitle': 'Pick an adult pet to breed.',
    'panel.ark.title': 'The Ark',
    'panel.ark.subtitle': 'Send adult pets for rewards.',
    'panel.ark.progress': 'Progress: {current} / {goal} aboard',
    'panel.ark.progressMine': ' · you sent {count}',
    'panel.ark.prompt': 'Tap a pet to send it aboard.',
    'panel.arkThanks.title': 'Thank You!',
    'panel.arkThanks.boarded': '{name} boarded the Ark.',
    'panel.arkThanks.rewards': '+{xp} Caretaker XP · +{coins} coins',
    'panel.arkThanks.firstDonation': "First donation! You'll receive this wearable:",
    'panel.arkLifted.title': 'The Ark has lifted off!',
    'panel.arkLifted.subtitle': 'Carrying companions to the stars.',
    'panel.arkLifted.thanks': "Thanks for sending {pets} of them — you'll receive {wearable}:",
    'panel.arkLifted.oneWearable': 'this wearable',
    'panel.arkLifted.manyWearables': 'these wearables',
    'panel.arkLifted.noDonation': 'Donate an Adult pet to the Captain to earn a reward on the next launch!',
    'daily.day': 'DAY {day}',
    'daily.today': 'TODAY',
    'pet.level': '{name} · Lv {level}',
    'pet.level.short': 'Lv {level}',
    'pet.action.pet': 'Pet · +Happy',
    'pet.action.breedLocked': 'Breed · Adult',
    'pet.action.arkLocked': 'Ark · Adult',
    'rarity.common': 'Common',
    'rarity.rare': 'Rare',
    'rarity.legendary': 'Legendary',
    'pet.wakeIn': 'Wake in {time}',
    'leaderboard.soon': 'soon'
  },
  es: {
    'tutorial.chapter': 'CAPÍTULO {current}/{total}',
    'language.notice.title': 'Idioma',
    'language.notice.body': 'El idioma de tu app de Decentraland es {language}. Para cambiarlo, ve a Profile > Settings > Language > Select language.',
    'language.notice.close': 'Cerrar',
    'language.picker.title': 'Elige idioma',
    'language.picker.body': 'Elige el idioma de Marsh Colony. Esta elección se guarda en tu cuenta.',
    'language.picker.close': 'Cerrar',
    'language.select': 'SELECCIONAR',
    'language.cancel': 'CANCELAR',
    'panel.adoptChoose.title': 'Elige una mascota',
    'panel.adoptChoose.subtitle': 'Elige un compañero para tu colonia.',
    'panel.adoptName.title': 'Nombra a tu mascota',
    'panel.adoptName.subtitle': 'Dale nombre a tu nueva compañera.',
    'panel.breedName.title': 'Nombra a tu cría',
    'panel.breedName.subtitle': 'Una poción mejora las chances raras.',
    'panel.inventory.title': 'Inventario',
    'panel.inventory.subtitle': 'Suministros para tus mascotas.',
    'panel.myPets.title': 'Mis mascotas',
    'panel.myPets.subtitle': 'Tus compañeras de colonia.',
    'panel.goals.title': 'Tu viaje',
    'panel.goals.subtitle': 'Completa pasos, gana recompensas.',
    'panel.goals.rewardSpin': '{coins} + giro',
    'panel.goals.rewardWearable': 'Vestible',
    'panel.goals.step.adopt': 'Adopta',
    'panel.goals.step.feed': 'Alimenta',
    'panel.goals.step.bath': 'Baño',
    'panel.goals.step.breed': 'Cría',
    'panel.goals.step.ark': 'Arca',
    'panel.jukebox.title': 'Jukebox',
    'panel.jukebox.subtitle': 'Música para tu colonia.',
    'panel.choosePartner.title': 'Elige pareja',
    'panel.choosePartner.subtitle': 'Elige una mascota adulta para criar.',
    'panel.ark.title': 'El Arca',
    'panel.ark.subtitle': 'Envía mascotas adultas por recompensas.',
    'panel.ark.progress': 'Progreso: {current} / {goal} a bordo',
    'panel.ark.progressMine': ' · enviaste {count}',
    'panel.ark.prompt': 'Toca una mascota para embarcarla.',
    'panel.arkThanks.title': '¡Gracias!',
    'panel.arkThanks.boarded': '{name} subió al Arca.',
    'panel.arkThanks.rewards': '+{xp} XP de cuidador · +{coins} monedas',
    'panel.arkThanks.firstDonation': '¡Primera donación! Recibirás este vestible:',
    'panel.arkLifted.title': '¡El Arca despegó!',
    'panel.arkLifted.subtitle': 'Lleva compañeros hacia las estrellas.',
    'panel.arkLifted.thanks': 'Gracias por enviar {pets}; recibirás {wearable}:',
    'panel.arkLifted.oneWearable': 'este vestible',
    'panel.arkLifted.manyWearables': 'estos vestibles',
    'panel.arkLifted.noDonation': 'Envía una mascota adulta al Capitán para ganar una recompensa en el próximo despegue.',
    'daily.day': 'DÍA {day}',
    'daily.today': 'HOY',
    'pet.level': '{name} · Nv {level}',
    'pet.level.short': 'Nv {level}',
    'pet.action.pet': 'Acariciar · +Felicidad',
    'pet.action.breedLocked': 'Criar · Adulto',
    'pet.action.arkLocked': 'Arca · Adulto',
    'rarity.common': 'Común',
    'rarity.rare': 'Raro',
    'rarity.legendary': 'Legendario',
    'pet.wakeIn': 'Despierta en {time}',
    'leaderboard.soon': 'próximamente'
  },
  pt: {
    'tutorial.chapter': 'CAPÍTULO {current}/{total}',
    'language.notice.title': 'Idioma',
    'language.notice.body': 'O idioma do seu app Decentraland é {language}. Para alterá-lo, vá em Profile > Settings > Language > Select language.',
    'language.notice.close': 'Fechar',
    'language.picker.title': 'Escolha o idioma',
    'language.picker.body': 'Escolha o idioma de Marsh Colony. Esta escolha é salva na sua conta.',
    'language.picker.close': 'Fechar',
    'language.select': 'SELECIONAR',
    'language.cancel': 'CANCELAR',
    'panel.adoptChoose.title': 'Escolha um pet',
    'panel.adoptChoose.subtitle': 'Escolha um companheiro para a colônia.',
    'panel.adoptName.title': 'Dê um nome ao pet',
    'panel.adoptName.subtitle': 'Dê um nome ao seu novo companheiro.',
    'panel.breedName.title': 'Nomeie sua cria',
    'panel.breedName.subtitle': 'Uma poção melhora as chances raras.',
    'panel.inventory.title': 'Inventário',
    'panel.inventory.subtitle': 'Suprimentos para seus pets.',
    'panel.myPets.title': 'Meus pets',
    'panel.myPets.subtitle': 'Companheiros da sua colônia.',
    'panel.goals.title': 'Sua jornada',
    'panel.goals.subtitle': 'Complete etapas, ganhe recompensas.',
    'panel.goals.rewardSpin': '{coins} + giro',
    'panel.goals.rewardWearable': 'Vestível',
    'panel.goals.step.adopt': 'Adote',
    'panel.goals.step.feed': 'Alimente',
    'panel.goals.step.bath': 'Banho',
    'panel.goals.step.breed': 'Cruze',
    'panel.goals.step.ark': 'Arca',
    'panel.jukebox.title': 'Jukebox',
    'panel.jukebox.subtitle': 'Música para sua colônia.',
    'panel.choosePartner.title': 'Escolha um parceiro',
    'panel.choosePartner.subtitle': 'Escolha um pet adulto para cruzar.',
    'panel.ark.title': 'A Arca',
    'panel.ark.subtitle': 'Envie pets adultos por recompensas.',
    'panel.ark.progress': 'Progresso: {current} / {goal} a bordo',
    'panel.ark.progressMine': ' · você enviou {count}',
    'panel.ark.prompt': 'Toque um pet para embarcá-lo.',
    'panel.arkThanks.title': 'Obrigado!',
    'panel.arkThanks.boarded': '{name} embarcou na Arca.',
    'panel.arkThanks.rewards': '+{xp} XP de cuidador · +{coins} moedas',
    'panel.arkThanks.firstDonation': 'Primeira doação! Você receberá este vestível:',
    'panel.arkLifted.title': 'A Arca decolou!',
    'panel.arkLifted.subtitle': 'Levando companheiros às estrelas.',
    'panel.arkLifted.thanks': 'Obrigado por enviar {pets}; você receberá {wearable}:',
    'panel.arkLifted.oneWearable': 'este vestível',
    'panel.arkLifted.manyWearables': 'estes vestíveis',
    'panel.arkLifted.noDonation': 'Envie um pet adulto ao Capitão para ganhar uma recompensa no próximo lançamento.',
    'daily.day': 'DIA {day}',
    'daily.today': 'HOJE',
    'pet.level': '{name} · Nv {level}',
    'pet.level.short': 'Nv {level}',
    'pet.action.pet': 'Carinho · +Felicidade',
    'pet.action.breedLocked': 'Cruzar · Adulto',
    'pet.action.arkLocked': 'Arca · Adulto',
    'rarity.common': 'Comum',
    'rarity.rare': 'Raro',
    'rarity.legendary': 'Lendário',
    'pet.wakeIn': 'Acorda em {time}',
    'leaderboard.soon': 'em breve'
  }
}

export function t(key: string, values: Record<string, string | number> = {}, language = currentLanguage): string {
  const template = COPY[language][key] ?? COPY.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}

function localizeToastTerm(term: string, language: AppLanguage): string {
  const terms: Record<AppLanguage, Dictionary> = {
    en: {},
    es: {
      'Magic Kibble': 'Croquetas mágicas',
      'Feast': 'Festín',
      'Rarity Potion': 'Poción de rareza',
      'Common': 'Común',
      'Rare': 'Raro',
      'Legendary': 'Legendario',
      'Free Spin': 'Giro gratis',
      'Mystery Prize': 'Premio misterioso',
      'PET SLOT!': '¡ESPACIO DE MASCOTA!',
      'First Meal': 'Primera comida',
      'Chef': 'Chef',
      'Squeaky Clean': 'Limpieza total',
      'Playful': 'Juguetón',
      'Good Neighbor': 'Buen vecino',
      'Seasoned Caretaker': 'Cuidador experimentado'
    },
    pt: {
      'Magic Kibble': 'Ração mágica',
      'Feast': 'Banquete',
      'Rarity Potion': 'Poção de raridade',
      'Common': 'Comum',
      'Rare': 'Raro',
      'Legendary': 'Lendário',
      'Free Spin': 'Giro grátis',
      'Mystery Prize': 'Prêmio misterioso',
      'PET SLOT!': 'VAGA DE PET!',
      'First Meal': 'Primeira refeição',
      'Chef': 'Chef',
      'Squeaky Clean': 'Muito limpo',
      'Playful': 'Brincalhão',
      'Good Neighbor': 'Bom vizinho',
      'Seasoned Caretaker': 'Cuidador experiente'
    }
  }
  return terms[language][term] ?? LEGACY[language][term] ?? term
}

function translateDynamic(text: string, language: AppLanguage): string {
  // Dynamic notifications include names, currency and timers, so their values
  // are kept while only the authored sentence is translated.
  const sick = text.match(/^(.+) is sick — cure it at the Care Center first\.$/)
  if (sick) return language === 'es' ? `${sick[1]} está enfermo. Cúralo primero en el Centro de cuidados.` : `${sick[1]} está doente — cure-o primeiro no Centro de cuidados.`

  const healthy = text.match(/^(.+) is healthy again!$/)
  if (healthy) return language === 'es' ? `¡${healthy[1]} está sano de nuevo!` : `${healthy[1]} está saudável de novo!`

  const tired = text.match(/^(.+) is too tired to play — (?:it )?needs to sleep(?: first)?\.$/)
  if (tired) return language === 'es' ? `${tired[1]} está demasiado cansado para jugar. Primero necesita dormir.` : `${tired[1]} está cansado demais para brincar — precisa dormir primeiro.`

  const fastAsleep = text.match(/^(.+) is fast asleep — (.+) left\.$/)
  if (fastAsleep) return language === 'es' ? `${fastAsleep[1]} está profundamente dormido — faltan ${fastAsleep[2]}.` : `${fastAsleep[1]} está dormindo profundamente — faltam ${fastAsleep[2]}.`

  const woke = text.match(/^(.+) woke up\.$/)
  if (woke) return language === 'es' ? `${woke[1]} se despertó.` : `${woke[1]} acordou.`

  const sleeping = text.match(/^(.+) is asleep in bed\.(?: It will rest for (.+) and can be woken in (.+)\.)?$/)
  if (sleeping) {
    if (!sleeping[2]) return language === 'es' ? `${sleeping[1]} está dormido en la cama.` : `${sleeping[1]} está dormindo na cama.`
    return language === 'es'
      ? `${sleeping[1]} está dormido en la cama. Descansará ${sleeping[2]} y podrá despertarse en ${sleeping[3]}.`
      : `${sleeping[1]} está dormindo na cama. Vai descansar por ${sleeping[2]} e poderá acordar em ${sleeping[3]}.`
  }

  const dozing = text.match(/^(.+) dozed off — not in bed, so it rests slower\.(?: It will rest for (.+) and can be woken in (.+)\.)?$/)
  if (dozing) {
    if (!dozing[2]) return language === 'es' ? `${dozing[1]} se quedó dormido fuera de la cama, así que descansará más lento.` : `${dozing[1]} cochilou fora da cama, então vai descansar mais devagar.`
    return language === 'es'
      ? `${dozing[1]} se quedó dormido fuera de la cama y descansará más lento. Descansará ${dozing[2]} y podrá despertarse en ${dozing[3]}.`
      : `${dozing[1]} cochilou fora da cama e vai descansar mais devagar. Vai descansar por ${dozing[2]} e poderá acordar em ${dozing[3]}.`
  }

  const settling = text.match(/^(.+) is settling in — Wake is available in (.+)\.$/)
  if (settling) return language === 'es' ? `${settling[1]} se está acomodando. Despertar estará disponible en ${settling[2]}.` : `${settling[1]} está se acomodando — Acordar estará disponível em ${settling[2]}.`

  const notSick = text.match(/^(.+) is not sick\.$/)
  if (notSick) return language === 'es' ? `${notSick[1]} no está enfermo.` : `${notSick[1]} não está doente.`

  const potionMissing = text.match(/^No (.+) in your inventory$/)
  if (potionMissing) return language === 'es' ? `No tienes ${localizeToastTerm(potionMissing[1], language)} en tu inventario.` : `Você não tem ${localizeToastTerm(potionMissing[1], language)} no inventário.`

  const breedingCost = text.match(/^Breeding costs (\d+) coins$/)
  if (breedingCost) return language === 'es' ? `Criar cuesta ${breedingCost[1]} monedas.` : `Cruzar custa ${breedingCost[1]} moedas.`

  const bred = text.match(/^You bred a (.+) egg(?: \((.+) used\))? — carry it home to hatch!\s*(?:\(-([\d]+) coins\))?$/)
  if (bred) {
    const rarity = localizeToastTerm(bred[1], language)
    const potion = bred[2] ? localizeToastTerm(bred[2], language) : ''
    const cost = bred[3] ? (language === 'es' ? ` (-${bred[3]} monedas)` : ` (-${bred[3]} moedas)`) : ''
    return language === 'es'
      ? `¡Criaste un huevo ${rarity}${potion ? ` (${potion} usada)` : ''}! Llévalo a casa para eclosionar.${cost}`
      : `Você cruzou um ovo ${rarity}${potion ? ` (${potion} usada)` : ''}! Leve-o para casa para chocar.${cost}`
  }

  const sickness = text.match(/^(.+) ate something bad and feels sick! Go see the Caretaker for medicine\.$/)
  if (sickness) return language === 'es' ? `¡${sickness[1]} comió algo malo y se siente enfermo! Ve con el Cuidador por medicina.` : `${sickness[1]} comeu algo ruim e está doente! Procure o Cuidador para pegar remédio.`

  const cureGift = text.match(/^The Caretaker gave you (\d+) coins for your bravery!$/)
  if (cureGift) return language === 'es' ? `¡El Cuidador te dio ${cureGift[1]} monedas por tu valentía!` : `O Cuidador deu ${cureGift[1]} moedas pela sua coragem!`

  const petted = text.match(/^You petted (.+)! \+(\d+) Giving$/)
  if (petted) return language === 'es' ? `¡Acariciaste a ${petted[1]}! +${petted[2]} de generosidad` : `Você fez carinho em ${petted[1]}! +${petted[2]} de generosidade`

  const treated = text.match(/^(.+) gave (.+) a treat!$/)
  if (treated) return language === 'es' ? `¡${treated[1]} le dio un premio a ${treated[2]}!` : `${treated[1]} deu um petisco para ${treated[2]}!`

  const busySwap = text.match(/^(.+) is (busy with a new pet|busy with their pet right now) — try again in a moment\.$/)
  if (busySwap) {
    const reason = busySwap[2] === 'busy with a new pet'
      ? (language === 'es' ? 'está ocupado con una nueva mascota' : 'está ocupado com um novo pet')
      : (language === 'es' ? 'está ocupado con su mascota ahora' : 'está ocupado com seu pet agora')
    return language === 'es' ? `${busySwap[1]} ${reason}. Inténtalo de nuevo en un momento.` : `${busySwap[1]} ${reason}. Tente novamente em um momento.`
  }

  const swapComplete = text.match(/^Swap complete — you got (.+)!$/)
  if (swapComplete) return language === 'es' ? `Intercambio completo: ¡recibiste a ${swapComplete[1]}!` : `Troca concluída — você recebeu ${swapComplete[1]}!`

  const swapAccepted = text.match(/^Swap accepted — you got (.+)!$/)
  if (swapAccepted) return language === 'es' ? `Intercambio aceptado: ¡recibiste a ${swapAccepted[1]}!` : `Troca aceita — você recebeu ${swapAccepted[1]}!`

  const fed = text.match(/^Fed (.+) a (.+)$/)
  if (fed) return language === 'es' ? `Le diste ${localizeToastTerm(fed[2], language)} a ${fed[1]}.` : `Você deu ${localizeToastTerm(fed[2], language)} para ${fed[1]}.`

  const devoured = text.match(/^(.+) devoured a (.+) — fully rested!$/)
  if (devoured) return language === 'es' ? `¡${devoured[1]} devoró un ${localizeToastTerm(devoured[2], language)} y descansó por completo!` : `${devoured[1]} devorou um ${localizeToastTerm(devoured[2], language)} — descansou completamente!`

  const boarded = text.match(/^(.+) boarded the Ark! \+(\d+) coins$/)
  if (boarded) return language === 'es' ? `¡${boarded[1]} subió al Arca! +${boarded[2]} monedas` : `${boarded[1]} embarcou na Arca! +${boarded[2]} moedas`

  const slot = text.match(/^Unlocked pet slot (\d+)!$/)
  if (slot) return language === 'es' ? `¡Desbloqueaste el espacio de mascota ${slot[1]}!` : `Você desbloqueou a vaga de pet ${slot[1]}!`

  const levelUp = text.match(/^Caretaker Level (\d+)!$/)
  if (levelUp) return language === 'es' ? `¡Nivel de Cuidador ${levelUp[1]}!` : `Nível de Cuidador ${levelUp[1]}!`

  const levelReward = text.match(/^Level reward: (.+)$/)
  if (levelReward) return language === 'es' ? `Recompensa de nivel: ${localizeToastTerm(levelReward[1], language)}` : `Recompensa de nível: ${localizeToastTerm(levelReward[1], language)}`

  const achievement = text.match(/^Achievement: (.+)! \+(\d+) coins$/)
  if (achievement) return language === 'es' ? `Logro: ${localizeToastTerm(achievement[1], language)}. +${achievement[2]} monedas` : `Conquista: ${localizeToastTerm(achievement[1], language)}! +${achievement[2]} moedas`

  const newAlbum = text.match(/^New in your Album! \+(\d+) coins$/)
  if (newAlbum) return language === 'es' ? `¡Nuevo en tu álbum! +${newAlbum[1]} monedas` : `Novo no seu álbum! +${newAlbum[1]} moedas`

  const albumSet = text.match(/^Album set complete! \+(\d+) coins$/)
  if (albumSet) return language === 'es' ? `¡Colección del álbum completa! +${albumSet[1]} monedas` : `Conjunto do álbum completo! +${albumSet[1]} moedas`

  const journey = text.match(/^Journey step done! \+(\d+) coins(?: \+(\d+) spin)?$/)
  if (journey) return language === 'es' ? `¡Paso del viaje completado! +${journey[1]} monedas${journey[2] ? ` +${journey[2]} giro` : ''}` : `Etapa da jornada concluída! +${journey[1]} moedas${journey[2] ? ` +${journey[2]} giro` : ''}`

  const dayStreak = text.match(/^Day (\d+) streak! \+(\d+) coins$/)
  if (dayStreak) return language === 'es' ? `¡Racha de ${dayStreak[1]} días! +${dayStreak[2]} monedas` : `Sequência de ${dayStreak[1]} dias! +${dayStreak[2]} moedas`

  const streakMilestone = text.match(/^Streak milestone day (\d+)! \+(\d+) coins, \+(\d+) spins$/)
  if (streakMilestone) return language === 'es' ? `¡Hito de racha del día ${streakMilestone[1]}! +${streakMilestone[2]} monedas, +${streakMilestone[3]} giros` : `Marco da sequência no dia ${streakMilestone[1]}! +${streakMilestone[2]} moedas, +${streakMilestone[3]} giros`

  const spin = text.match(/^Spin: (.+)!$/)
  if (spin) return `Giro: ${localizeToastTerm(spin[1], language)}!`

  const meteor = text.match(/^Meteor: (.+)!$/)
  if (meteor) return language === 'es' ? `Meteorito: ${localizeToastTerm(meteor[1], language)}!` : `Meteoro: ${localizeToastTerm(meteor[1], language)}!`

  const daily = text.match(/^Daily reward: \+(\d+) coins(?: \+(\d+) spins)?!$/)
  if (daily) return language === 'es' ? `Recompensa diaria: +${daily[1]} monedas${daily[2] ? ` +${daily[2]} giros` : ''}!` : `Recompensa diária: +${daily[1]} moedas${daily[2] ? ` +${daily[2]} giros` : ''}!`

  const firstSlotGift = text.match(/^The Caretaker chipped in (\d+) coins for the baby's slot!$/)
  if (firstSlotGift) return language === 'es' ? `¡El Cuidador aportó ${firstSlotGift[1]} monedas para el espacio de la cría!` : `O Cuidador contribuiu com ${firstSlotGift[1]} moedas para a vaga do filhote!`

  const hatched = text.match(/^Your (.+) hatched!$/)
  if (hatched) return language === 'es' ? `¡Tu ${hatched[1]} eclosionó!` : `Seu ${hatched[1]} chocou!`

  const wornOut = text.match(/^(.+) is worn out — time for bed\.$/)
  if (wornOut) return language === 'es' ? `${wornOut[1]} está agotado. ¡Es hora de dormir!` : `${wornOut[1]} está exausto — hora de dormir.`

  const asleepDonate = text.match(/^(.+) is asleep — let it wake up first\.$/)
  if (asleepDonate) return language === 'es' ? `${asleepDonate[1]} está dormido. Déjalo despertar primero.` : `${asleepDonate[1]} está dormindo — deixe-o acordar primeiro.`

  const putDown = text.match(/^Put (.+) down first\.$/)
  if (putDown) return language === 'es' ? `Primero deja a ${putDown[1]} en el suelo.` : `Primeiro coloque ${putDown[1]} no chão.`

  const pendingSwap = text.match(/^(.+) is part of a pending swap\.$/)
  if (pendingSwap) return language === 'es' ? `${pendingSwap[1]} forma parte de un intercambio pendiente.` : `${pendingSwap[1]} faz parte de uma troca pendente.`

  const stageGrown = text.match(/^(.+) grew into (Junior|Teenager)!$/)
  if (stageGrown) return language === 'es' ? `${stageGrown[1]} creció y ahora es ${localizeToastTerm(stageGrown[2], language)}.` : `${stageGrown[1]} cresceu e virou ${localizeToastTerm(stageGrown[2], language)}!`

  const selectPet = text.match(/^Select (.+)$/)
  if (selectPet) return language === 'es' ? `Seleccionar ${selectPet[1]}` : `Selecionar ${selectPet[1]}`

  const levelWithName = text.match(/^(.+)\s+·\s+Lv (\d+)$/)
  if (levelWithName) return t('pet.level', { name: levelWithName[1], level: levelWithName[2] }, language)

  const rarityWithName = text.match(/^(.+)\s+·\s+(Common|Rare|Legendary)$/)
  if (rarityWithName) return `${rarityWithName[1]} · ${t(`rarity.${rarityWithName[2].toLowerCase()}`, {}, language)}`

  const albumPage = text.match(/^(.+) Album page complete! \+(\d+) coins(?: \+(\d+) spins)?$/)
  if (albumPage) return language === 'es' ? `¡Página ${localizeToastTerm(albumPage[1], language)} del álbum completa! +${albumPage[2]} monedas${albumPage[3] ? ` +${albumPage[3]} giros` : ''}` : `Página ${localizeToastTerm(albumPage[1], language)} do álbum completa! +${albumPage[2]} moedas${albumPage[3] ? ` +${albumPage[3]} giros` : ''}`


  const caretakerWelcome = text.match(/^Welcome to the Mars colony, (.+)\. I'm the Caretaker — out here, every colony is built on the creatures we raise\.$/)
  if (caretakerWelcome) {
    return language === 'es'
      ? `Te damos la bienvenida a la colonia de Marte, ${caretakerWelcome[1]}. Soy el Cuidador: aquí cada colonia se construye con las criaturas que criamos.`
      : `Boas-vindas à colônia de Marte, ${caretakerWelcome[1]}. Sou o Cuidador: aqui, cada colônia é construída com as criaturas que criamos.`
  }

  const captainWelcome = text.match(/^Welcome aboard, (.+)! This Ark will carry our companions to a new colony among the stars\.$/)
  if (captainWelcome) {
    return language === 'es'
      ? `¡Bienvenido a bordo, ${captainWelcome[1]}! Esta Arca llevará a nuestros compañeros a una nueva colonia entre las estrellas.`
      : `Boas-vindas a bordo, ${captainWelcome[1]}! Esta Arca levará nossos companheiros a uma nova colônia entre as estrelas.`
  }

  const arkGoal = text.match(/^When (\d+) pets are aboard, the Ark launches and everyone who sent a pet receives a special wearable\. (\d+) \/ (\d+) aboard so far!$/)
  if (arkGoal) {
    return language === 'es'
      ? `Cuando haya ${arkGoal[1]} mascotas a bordo, el Arca despegará y todos recibirán un wearable especial. Van ${arkGoal[2]} / ${arkGoal[3]}.`
      : `Quando houver ${arkGoal[1]} pets a bordo, a Arca partirá e todos receberão um wearable especial. Até agora: ${arkGoal[2]} / ${arkGoal[3]}.`
  }

  const nestPartner = text.match(/^In the house there is a breeding nest\. My (.+) is waiting in its second bowl: this time it will be your pet's partner\.$/)
  if (nestPartner) {
    return language === 'es'
      ? `En la casa hay un nido de cría. Mi ${nestPartner[1]} espera en el segundo cuenco: esta vez será la pareja de tu mascota.`
      : `Na casa há um ninho de criação. Meu ${nestPartner[1]} está esperando no segundo pote: desta vez será o parceiro do seu pet.`
  }

  const slotPrice = text.match(/^A new slot costs (\d+) coins\. Yours are piling up while your pet is happy!$/)
  if (slotPrice) {
    return language === 'es'
      ? `Un nuevo espacio cuesta ${slotPrice[1]} monedas. ¡Las tuyas se acumulan mientras tu mascota está feliz!`
      : `Uma nova vaga custa ${slotPrice[1]} moedas. As suas se acumulam enquanto seu pet está feliz!`
  }

  const chapter = text.match(/^Chapter (\d+)\/(\d+)$/)
  if (chapter) return language === 'es' ? `Capítulo ${chapter[1]}/${chapter[2]}` : `Capítulo ${chapter[1]}/${chapter[2]}`

  const name = text.match(/^(.+) joined your colony!$/)
  if (name) return language === 'es' ? `${name[1]} se unió a tu colonia.` : `${name[1]} entrou na sua colônia!`

  const grown = text.match(/^(.+) grew into an Adult!$/)
  if (grown) return language === 'es' ? `${grown[1]} creció y es adulto.` : `${grown[1]} cresceu e virou adulto!`

  const cured = text.match(/^(.+) is cured!$/)
  if (cured) return language === 'es' ? `¡${cured[1]} está curado!` : `${cured[1]} está curado!`

  const boughtItem = text.match(/^Bought (.+?)(!)?$/)
  if (boughtItem) return language === 'es' ? `Compraste ${localizeToastTerm(boughtItem[1], language)}${boughtItem[2] ?? ''}` : `Você comprou ${localizeToastTerm(boughtItem[1], language)}${boughtItem[2] ?? ''}`

  const bought = text.match(/^Bought (.+)!?$/)
  if (bought) return language === 'es' ? `Compraste ${bought[1]}` : `Você comprou ${bought[1]}`

  const level = text.match(/^Lv (\d+)$/)
  if (level) return language === 'es' ? `Nv ${level[1]}` : `Nv ${level[1]}`

  return text
}
