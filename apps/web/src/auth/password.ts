/**
 * Password rules for email accounts (card rxGgHFZs): at least 8 characters and not one of the
 * most common passwords. The list is built in (no network call) and is only loaded with the
 * sign-in code. Comparison ignores case.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_RULE = 'At least 8 characters, and not a common password.';

// Frequently used passwords of 8+ characters (shorter ones fail the length rule anyway).
const COMMON = `
password passw0rd p@ssw0rd p@ssword password1 password12 password123 password1234 password12345
passw0rd1 pass1234 pass12345 password! password# password@ 12345678 123456789 1234567890 12345678910
123123123 1234567891 0123456789 987654321 9876543210 987654321 11111111 111111111 1111111111 22222222
33333333 44444444 55555555 66666666 77777777 88888888 99999999 00000000 000000000 1q2w3e4r 1q2w3e4r5t
1q2w3e4r5t6y 1qaz2wsx 1qaz2wsx3edc 1qazxsw2 qazwsxedc qazwsx123 zaq12wsx zaq1zaq1 q1w2e3r4 q1w2e3r4t5
qwertyui qwertyuiop qwerty12 qwerty123 qwerty1234 qwerty12345 qwerty123456 qwertyuiop123 qwerty1!
asdfghjk asdfghjkl asdfgh123 asdf1234 asdfasdf asdf12345 zxcvbnm zxcvbnm1 zxcvbnm123 zxcvbnm12 azertyuiop
azerty123 abcd1234 abcd12345 abcdefgh abcdefghi abcdefghij abcde12345 abc12345 abc123456 abcabc123
iloveyou iloveyou1 iloveyou2 iloveyou12 iloveyou123 iloveyou! iloveyou69 iloveyou2 ilovemyself ilovehim
iloveher iloveu123 ilovegod ilovemom ilovedad ilovelife ilovejesus ilovesex ilovemoney
welcome1 welcome12 welcome123 welcome1234 welcome! welcome@1 welcome01 letmein1 letmein12 letmein123
letmein! letmein2 letmein01 trustno1 trustno12 trustno123 admin123 admin1234 admin12345 administrator
administrator1 adminadmin admin@123 admin@1234 admin1 root1234 rootroot toor1234 changeme changeme1
changeme123 changeit default1 default123 guest123 guest1234 test1234 test12345 testtest test123456
testing1 testing123 tester123 temp1234 temp12345 temppass temppassword temp123 demo1234 demo12345
monkey12 monkey123 monkey1234 monkey1! dragon12 dragon123 dragon1234 dragon! football football1
football12 football123 baseball baseball1 baseball12 baseball123 basketball basketball1 soccer123
hockey123 volleyball tennis123 golfer123 mustang1 mustang12 mustang123 shadow12 shadow123 shadow1234
master12 master123 master1234 mastermaster sunshine sunshine1 sunshine12 sunshine123 sunshine! princess
princess1 princess12 princess123 princess! superman superman1 superman12 superman123 batman12 batman123
spiderman spiderman1 spiderman123 starwars starwars1 starwars123 pokemon1 pokemon123 minecraft minecraft1
minecraft123 michael1 michael12 michael123 jennifer jennifer1 jessica1 jessica123 charlie1 charlie12
charlie123 jordan23 jordan123 jordan12 hunter12 hunter123 hunter1234 secret12 secret123 secret1234
summer12 summer123 summer2020 winter12 winter123 spring123 autumn123 hello123 hello1234 hello12345
helloworld helloworld1 hello@123 freedom1 freedom123 whatever whatever1 whatever123 nothing1 nothing123
computer computer1 computer12 computer123 internet internet1 internet123 samsung1 samsung123 google123
google12345 facebook facebook1 facebook123 youtube1 youtube123 twitter1 twitter123 instagram instagram1
microsoft microsoft1 windows1 windows10 windows123 apple123 iphone123 android1 android123 linux123 ubuntu123
football99 liverpool liverpool1 chelsea1 chelsea123 arsenal1 arsenal123 manchester manutd123 barcelona
barcelona1 realmadrid realmadrid1 juventus juventus1 benfica1 benfica123 sporting1 portugal portugal1
portugal123 brasil123 brazil123 england1 england123 america1 america123 canada123 germany1 germany123
france123 espana123 italia123 mexico123 mexico12 london123 paris123 newyork1 newyork123 california
california1 texas123 florida1 florida123 chicago1 chicago123 boston123 dallas123 dallas1234
loveyou1 loveyou123 loveme123 loveme1234 lovelove lovelove1 love1234 love12345 love123456 lover123
lovers123 lovely123 lovely12 loveyou2 lovebug1 mylove123 mylove12 babygirl babygirl1 babygirl12 babygirl123
babyboy1 baby1234 baby12345 sweetheart sweetie1 sweet123 honey123 honey1234 angel123 angel1234 angels123
butterfly butterfly1 butterfly2 flower123 flower12 flowers1 rainbow1 rainbow123 cookie123 cookie12
chocolate chocolate1 chocolate12 chocolate123 banana123 cheese123 pepper123 peanut123 cherry123 orange123
tiger123 tiger1234 lion1234 eagle123 eagles123 wolf1234 panther1 bulldog1 bulldog123 rocket123 rocky123
killer123 killer1234 ninja123 ninja1234 pirate123 samurai1 warrior1 warrior123 hunter99 gamer123 gaming123
player123 playboy1 playboy123 cowboys1 cowboy123 yankees1 yankees123 steelers steelers1 lakers123
lakers24 jordan1 harley123 yamaha123 honda123 toyota123 ferrari1 ferrari123 mercedes mercedes1 mercedes123
porsche1 porsche911 bmw12345 corvette corvette1 camaro123 mustang99 chevy123 ford1234 nissan123
qwertyuiop1 qweasdzxc qweasd123 qweqweqwe qwe12345 qwe123456 qwe123qwe qweqwe123 123qweasd 123qwe123
123qwerty 123456qwerty 123abc123 123abcabc 123456abc 123456aa 123456a! 123456789a 123456789q a123456789
a12345678 a1234567 a123456a q123456789 q12345678 z123456789 aa123456 aa12345678 aaaaaaaa aaaaaaaaa
aaaaaaaaaa bbbbbbbb cccccccc 12341234 123412345 1234abcd 12344321 12345123 123454321 123456123 12345654321
12345678a 12345678q 123456789z 123456780 1234567a 1234qwer 1234qwer! 12qwaszx 12345qwert 1234554321
123123123123 123321123 123321123321 147258369 147852369 159753159 159357159 159753456 741852963 963852741
789456123 456789123 321654987 987456321 654321654 1357924680 2468013579 1029384756 0987654321 09876543
1qazzaq1 1qazxsw23edc zxcasdqwe zxcasdqwe123 asdqwe123 asdasdasd asdasd123 asd123asd asdzxc123 asdfzxcv
mnbvcxz1 mnbvcxzlkjhgfdsapoiuytrewq poiuytrewq lkjhgfdsa poiuytre lkjhgfds qazqazqaz qwertzui qwertz123
passwort passwort1 passwort123 motdepasse motdepasse1 contrasena contraseña password01 password02 password11
password22 password99 password100 password111 password321 passwordpassword mypassword mypassword1
mypassword123 mypass123 mypasswd1 mypassw0rd newpassword newpassword1 newpass123 oldpass123 yourpassword
thepassword userpassword secretpassword supersecret superman99 topsecret topsecret1 pass@word1 pass@1234
passpass1 passpass123 pa$$word pa$$w0rd p4ssw0rd pass1word passw0rd! passw0rd1 passw0rd123 paSSword
Password1 Password123 Passw0rd! Passw0rd1 P@ssw0rd1 P@ssword1 P@ssw0rd123 Qwerty123 Qwerty123! Welcome123
Admin123 Admin@123 Letmein123 Abc12345 Abcd1234 Iloveyou1 Monkey123 Dragon123 Football1 Baseball1
michelle1 michelle ashley123 ashley12 nicole123 nicole12 daniel123 daniel12 andrew123 joshua123 joshua12
matthew1 matthew123 anthony1 anthony123 thomas123 thomas12 robert123 william1 william123 richard1
christian christian1 jonathan jonathan1 jesus123 jesus1234 jesuschrist godisgood godbless1 blessed1
blessed123 maria123 maria1234 carlos123 miguel123 joao1234 joao12345 pedro123 diogo123 tiago123 rui12345
sofia123 ines1234 ana12345 
cristiano cristiano7 ronaldo7 ronaldo777 messi1010 neymar11 
starbucks starlight starwars7 skywalker skywalker1 darkness darkside darkangel blackbird blackout blackjack
blackcat blackdog bluesky1 blueberry bluemoon1 redwings redskins redhead1 redrose1 greenday greenday1 
goldfish goldie12 silver12 silver123 silverado diamond1 diamond123 diamonds1 platinum platinum1 crystal1
crystal123 emerald1 purple123 purple12 yellow12 yellow123 orange12 pink1234 pinkpink1 
nirvana1 metallica metallica1 slipknot1 linkinpark eminem123 eminem12 beatles1 madonna1 shakira1 rihanna1
justin123 bieber123 hannah123 hannahmontana pokemon99 digimon1 naruto123 naruto1234 sasuke123 goku1234
dragonball dragonball1 zelda123 mario123 mario1234 sonic123 nintendo nintendo1 playstation playstation1
xbox1234 xbox360 xbox3601 gta12345 fortnite fortnite1 fortnite123 roblox123 roblox1234 runescape counterstrike
warcraft warcraft1 diablo123 skyrim123 halo1234 callofduty
killer12 blink182 slayer666 satan666 666666666 6666666666 777777777 7777777 888888888 999999999 1212121212
121212121 12121212 21212121 13131313 14141414 696969696 69696969 6969696969 420420420 42042069 
lovelife lovelife1 happy123 happy1234 happyday1 happyhappy smile123 smile1234 lucky123 lucky1234 lucky777
luckyone1 money123 money1234 moneymoney money4me cash1234 rich1234 millionaire 
iamawesome iamthebest iloveme1 imissyou1 imissyou iamhappy1 forever1 forever123 foreverlove 4everlove
friends1 friends123 friendship family123 family1234 mother123 father123 brother1 sister123 daddy123 mommy123
baby12345 princess2 prince123 king12345 queen123 queen1234 lady1234 
snoopy123 snoopy12 tweety123 garfield1 pooh1234 winniethepooh mickey123 mickey1234 minnie123 disney123
disney1234 simpsons simpsons1 bart1234 homer123 scooby123 scoobydoo scoobydoo1 pluto123 
mother1 whatever1 anything1 anything123 something1 something123 everything1 nobody123 nothing12 
dolphin1 dolphins1 elephant1 elephant123 giraffe1 penguin1 penguin123 kitten123 kitty123 kitty1234 puppy123 
puppy1234 doggie123 doggy123 cat12345 dog12345 horse123 horses123 rabbit123 monkey99 turtle123 
sunflower sunflower1 sunshine7 moonlight moonlight1 starlight1 stars123 sunrise1 sunset123 
october1 october12 november1 december1 january1 february1 march123 april123 june1234 july1234 august123 
september september1 monday123 tuesday1 wednesday thursday1 friday123 saturday sunday123 
spring2020 summer2021 summer2022 summer2023 summer2024 summer2025 winter2020 winter2021 winter2022 
winter2023 winter2024 winter2025 autumn2020 spring2021 spring2022 spring2023 spring2024 spring2025
`;

// Common word + common ending, e.g. password2024, qwerty!, welcome01.
const BASES = [
  'password',
  'passw0rd',
  'qwerty',
  'qwertyuiop',
  'welcome',
  'letmein',
  'admin',
  'administrator',
  'iloveyou',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'master',
  'sunshine',
  'princess',
  'shadow',
  'superman',
  'batman',
  'michael',
  'charlie',
  'jordan',
  'hunter',
  'secret',
  'summer',
  'winter',
  'hello',
  'freedom',
  'whatever',
  'trustno',
  'login',
  'access',
  'mustang',
  'starwars',
  'computer',
  'internet',
  'abc',
  'abcd',
  'test',
  'tester',
  'guest',
  'user',
  'root',
  'changeme',
  'default',
  'love',
  'angel',
  'killer',
  'cookie',
  'flower',
  'tiger',
  'soccer',
  'hockey',
  'ranger',
  'buster',
  'thomas',
  'robert',
  'jessica',
  'jennifer',
  'ashley',
  'nicole',
  'daniel',
  'andrew',
  'joshua',
  'matthew',
  'maggie',
  'pepper',
  'ginger',
  'cheese',
  'banana',
  'orange',
  'purple',
  'silver',
  'golden',
  'diamond',
  'rocket',
  'hannah',
  'samantha',
  'amanda',
  'brandon',
  'jasmine',
  'lauren',
  'taylor',
  'austin',
  'tigger',
];
const ENDINGS = [
  '1',
  '12',
  '123',
  '1234',
  '12345',
  '123456',
  '!',
  '!!',
  '1!',
  '123!',
  '@123',
  '#1',
  '01',
  '007',
  '11',
  '13',
  '21',
  '22',
  '23',
  '69',
  '77',
  '99',
  '100',
  '111',
  '321',
  '666',
  '777',
  '2000',
  '2010',
  '2015',
  '2018',
  '2019',
  '2020',
  '2021',
  '2022',
  '2023',
  '2024',
  '2025',
  '2026',
];

const BLOCKED = new Set<string>();
for (const w of COMMON.split(/\s+/)) if (w) BLOCKED.add(w.toLowerCase());
for (const b of BASES) for (const e of ENDINGS) BLOCKED.add(b + e);

/** True for a password on the built-in common list (case-insensitive). */
export function isCommonPassword(pw: string): boolean {
  return BLOCKED.has(pw.trim().toLowerCase());
}

/** All one character, or a plain run like 12345678 / abcdefgh. */
function isTrivial(pw: string): boolean {
  if (/^(.)\1+$/.test(pw)) return true;
  const step = (s: string, d: number) =>
    [...s].every((c, i) => i === 0 || c.charCodeAt(0) - s.charCodeAt(i - 1) === d);
  return step(pw, 1) || step(pw, -1);
}

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'Use at least 8 characters.';
  if (isTrivial(pw) || isCommonPassword(pw)) {
    return 'That password is too common. Choose a less guessable one.';
  }
  return null;
}

/** Client-side shape check: something@domain.tld (the browser's own check accepts "a@b"). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
}
