const path = require('path');
const fs = require('fs');
const os = require('os');

function writeTempCSV(name, content) {
  const filePath = path.join(os.tmpdir(), name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function uploadFiles(page, ...csvContents) {
  const paths = csvContents.map(([name, content]) => writeTempCSV(name, content));
  await page.locator('#file-input').setInputFiles(paths);
  await page.waitForTimeout(700);
}

const smallSlateFixture = {
  dkCsv: [
    'Position,Name + ID,Name,ID,Roster Position,TeamAbbrev,Salary,Game Info,AvgPointsPerGame',
    'SP,Gerrit Cole (20000001),Gerrit Cole,20000001,P,NYY,6600,NYY@BOS 05/21/2026 07:10PM ET,25.0',
    'SP,Chris Sale (20000002),Chris Sale,20000002,P,BOS,5800,NYY@BOS 05/21/2026 07:10PM ET,19.0',
    'C,Will Smith (20000010),Will Smith,20000010,C,LAD,3600,LAD@ATL 05/21/2026 07:10PM ET,9.0',
    '1B,Freddie Freeman (20000014),Freddie Freeman,20000014,1B,LAD,4000,LAD@ATL 05/21/2026 07:10PM ET,11.0',
    '2B,Jose Altuve (20000019),Jose Altuve,20000019,2B,HOU,3800,HOU@CLE 05/21/2026 07:10PM ET,10.0',
    '3B,Jose Ramirez (20000027),Jose Ramirez,20000027,3B,CLE,3800,HOU@CLE 05/21/2026 07:10PM ET,10.0',
    'SS,Francisco Lindor (20000033),Francisco Lindor,20000033,SS,NYM,4000,PHI@NYM 05/21/2026 04:10PM ET,10.5',
    'OF,Juan Soto (20000034),Juan Soto,20000034,OF,NYY,4200,NYY@BOS 05/21/2026 07:10PM ET,12.0',
    'OF,Yordan Alvarez (20000037),Yordan Alvarez,20000037,OF,HOU,4200,HOU@CLE 05/21/2026 07:10PM ET,12.5',
    'OF,Mookie Betts (20000041),Mookie Betts,20000041,OF,LAD,4200,LAD@ATL 05/21/2026 07:10PM ET,12.5',
  ].join('\n'),
  rooCsv: [
    'Name,Position,Team,Salary,Floor,Median,Ceiling,Own%,Batting Order',
    'Gerrit Cole,SP,NYY,6600,6.3,25.0,42.0,22.0,0',
    'Chris Sale,SP,BOS,5800,4.8,19.0,32.0,14.0,0',
    'Will Smith,C,LAD,3600,2.7,9.0,18.0,10.0,5',
    'Freddie Freeman,1B,LAD,4000,3.3,11.0,22.0,14.0,3',
    'Jose Altuve,2B,HOU,3800,3.0,10.0,20.0,11.0,2',
    'Jose Ramirez,3B,CLE,3800,3.0,10.0,20.0,13.0,3',
    'Francisco Lindor,SS,NYM,4000,3.2,10.5,21.0,13.0,3',
    'Juan Soto,OF,NYY,4200,3.6,12.0,24.0,16.0,3',
    'Yordan Alvarez,OF,HOU,4200,3.8,12.5,25.0,18.0,3',
    'Mookie Betts,OF,LAD,4200,3.8,12.5,25.0,18.0,1',
  ].join('\n'),
  lineupNames: [
    'Gerrit Cole',
    'Chris Sale',
    'Will Smith',
    'Freddie Freeman',
    'Jose Altuve',
    'Jose Ramirez',
    'Francisco Lindor',
    'Juan Soto',
    'Yordan Alvarez',
    'Mookie Betts',
  ],
};

const richPortfolioFixture = {
  dkCsv: `Position,Name + ID,Name,ID,Roster Position,TeamAbbrev,Salary,Game Info,AvgPointsPerGame
SP,Gerrit Cole (20000001),Gerrit Cole,20000001,P,NYY,6600,NYY@BOS 04/24/2026 07:10PM ET,25.0
SP,Chris Sale (20000002),Chris Sale,20000002,P,BOS,5800,NYY@BOS 04/24/2026 07:10PM ET,19.0
SP,Framber Valdez (20000003),Framber Valdez,20000003,P,HOU,6400,HOU@CLE 04/24/2026 07:10PM ET,23.0
SP,Shane Bieber (20000004),Shane Bieber,20000004,P,CLE,6200,HOU@CLE 04/24/2026 07:10PM ET,21.0
SP,Clayton Kershaw (20000005),Clayton Kershaw,20000005,P,LAD,6600,LAD@ATL 04/24/2026 07:10PM ET,25.0
SP,Charlie Morton (20000006),Charlie Morton,20000006,P,ATL,5600,LAD@ATL 04/24/2026 07:10PM ET,17.0
C,Salvador Perez (20000007),Salvador Perez,20000007,C,KC,3000,KC@MIN 04/24/2026 01:10PM ET,7.0
C,Sean Murphy (20000008),Sean Murphy,20000008,C,ATL,3400,LAD@ATL 04/24/2026 07:10PM ET,8.5
C,Adley Rutschman (20000009),Adley Rutschman,20000009,C,BAL,3800,BAL@TB 04/24/2026 04:10PM ET,10.0
C,Will Smith (20000010),Will Smith,20000010,C,LAD,3600,LAD@ATL 04/24/2026 07:10PM ET,9.0
1B,Anthony Rizzo (20000011),Anthony Rizzo,20000011,1B,NYY,3400,NYY@BOS 04/24/2026 07:10PM ET,8.0
1B,Triston Casas (20000012),Triston Casas,20000012,1B,BOS,3400,NYY@BOS 04/24/2026 07:10PM ET,8.0
1B,Jose Abreu (20000013),Jose Abreu,20000013,1B,HOU,3000,HOU@CLE 04/24/2026 07:10PM ET,7.0
1B,Freddie Freeman (20000014),Freddie Freeman,20000014,1B,LAD,4000,LAD@ATL 04/24/2026 07:10PM ET,11.0
1B,Matt Olson (20000015),Matt Olson,20000015,1B,ATL,3800,LAD@ATL 04/24/2026 07:10PM ET,10.0
1B,Josh Naylor (20000016),Josh Naylor,20000016,1B,CLE,3200,HOU@CLE 04/24/2026 07:10PM ET,7.5
2B,Gleyber Torres (20000017),Gleyber Torres,20000017,2B,NYY,3600,NYY@BOS 04/24/2026 07:10PM ET,9.0
2B,Kike Hernandez (20000018),Kike Hernandez,20000018,2B,BOS,3000,NYY@BOS 04/24/2026 07:10PM ET,6.5
2B,Jose Altuve (20000019),Jose Altuve,20000019,2B,HOU,3800,HOU@CLE 04/24/2026 07:10PM ET,10.0
2B,Miguel Vargas (20000020),Miguel Vargas,20000020,2B,LAD,3200,LAD@ATL 04/24/2026 07:10PM ET,7.5
2B,Ozzie Albies (20000021),Ozzie Albies,20000021,2B,ATL,3600,LAD@ATL 04/24/2026 07:10PM ET,9.0
2B,Andres Gimenez (20000022),Andres Gimenez,20000022,2B,CLE,3200,HOU@CLE 04/24/2026 07:10PM ET,7.5
3B,Rafael Devers (20000023),Rafael Devers,20000023,3B,BOS,3800,NYY@BOS 04/24/2026 07:10PM ET,10.0
3B,Alex Bregman (20000024),Alex Bregman,20000024,3B,HOU,3800,HOU@CLE 04/24/2026 07:10PM ET,10.0
3B,Max Muncy (20000025),Max Muncy,20000025,3B,LAD,3400,LAD@ATL 04/24/2026 07:10PM ET,8.5
3B,Austin Riley (20000026),Austin Riley,20000026,3B,ATL,3600,LAD@ATL 04/24/2026 07:10PM ET,9.5
3B,Jose Ramirez (20000027),Jose Ramirez,20000027,3B,CLE,3800,HOU@CLE 04/24/2026 07:10PM ET,10.0
SS,Xander Bogaerts (20000028),Xander Bogaerts,20000028,SS,BOS,3400,NYY@BOS 04/24/2026 07:10PM ET,8.5
SS,Jeremy Pena (20000029),Jeremy Pena,20000029,SS,HOU,3400,HOU@CLE 04/24/2026 07:10PM ET,8.5
SS,Dansby Swanson (20000030),Dansby Swanson,20000030,SS,ATL,3200,LAD@ATL 04/24/2026 07:10PM ET,8.0
SS,Gavin Lux (20000031),Gavin Lux,20000031,SS,LAD,3200,LAD@ATL 04/24/2026 07:10PM ET,7.5
SS,Trea Turner (20000032),Trea Turner,20000032,SS,PHI,3800,PHI@NYM 04/24/2026 04:10PM ET,9.5
SS,Francisco Lindor (20000033),Francisco Lindor,20000033,SS,NYM,4000,PHI@NYM 04/24/2026 04:10PM ET,10.5
OF,Juan Soto (20000034),Juan Soto,20000034,OF,NYY,4200,NYY@BOS 04/24/2026 07:10PM ET,12.0
OF,Aaron Judge (20000035),Aaron Judge,20000035,OF,NYY,4000,NYY@BOS 04/24/2026 07:10PM ET,11.5
OF,Jarren Duran (20000036),Jarren Duran,20000036,OF,BOS,3600,NYY@BOS 04/24/2026 07:10PM ET,9.0
OF,Yordan Alvarez (20000037),Yordan Alvarez,20000037,OF,HOU,4200,HOU@CLE 04/24/2026 07:10PM ET,12.5
OF,Kyle Tucker (20000038),Kyle Tucker,20000038,OF,HOU,3800,HOU@CLE 04/24/2026 07:10PM ET,10.5
OF,Ronald Acuna Jr (20000039),Ronald Acuna Jr,20000039,OF,ATL,4400,LAD@ATL 04/24/2026 07:10PM ET,13.0
OF,Steven Kwan (20000040),Steven Kwan,20000040,OF,CLE,3400,HOU@CLE 04/24/2026 07:10PM ET,8.5
OF,Mookie Betts (20000041),Mookie Betts,20000041,OF,LAD,4200,LAD@ATL 04/24/2026 07:10PM ET,12.5
`,
  rooCsv: `Name,Position,Team,Salary,Floor,Median,Ceiling,Own%,Batting Order
Gerrit Cole,SP,NYY,6600,6.3,25.0,42.0,22.0,0
Chris Sale,SP,BOS,5800,4.8,19.0,32.0,14.0,0
Framber Valdez,SP,HOU,6400,5.8,23.0,39.0,18.0,0
Shane Bieber,SP,CLE,6200,5.3,21.0,36.0,16.0,0
Clayton Kershaw,SP,LAD,6600,6.3,25.0,42.0,22.0,0
Charlie Morton,SP,ATL,5600,4.3,17.0,29.0,12.0,0
Salvador Perez,C,KC,3000,2.1,7.0,14.0,8.0,5
Sean Murphy,C,ATL,3400,2.6,8.5,17.0,7.0,6
Adley Rutschman,C,BAL,3800,3.0,10.0,20.0,12.0,2
Will Smith,C,LAD,3600,2.7,9.0,18.0,10.0,5
Anthony Rizzo,1B,NYY,3400,2.4,8.0,16.0,7.0,4
Triston Casas,1B,BOS,3400,2.4,8.0,16.0,7.0,4
Jose Abreu,1B,HOU,3000,2.1,7.0,14.0,6.0,5
Freddie Freeman,1B,LAD,4000,3.3,11.0,22.0,14.0,3
Matt Olson,1B,ATL,3800,3.0,10.0,20.0,12.0,3
Josh Naylor,1B,CLE,3200,2.3,7.5,15.0,6.0,4
Gleyber Torres,2B,NYY,3600,2.7,9.0,18.0,8.0,5
Kike Hernandez,2B,BOS,3000,2.0,6.5,13.0,5.0,7
Jose Altuve,2B,HOU,3800,3.0,10.0,20.0,11.0,2
Miguel Vargas,2B,LAD,3200,2.3,7.5,15.0,6.0,7
Ozzie Albies,2B,ATL,3600,2.7,9.0,18.0,9.0,2
Andres Gimenez,2B,CLE,3200,2.3,7.5,15.0,7.0,2
Rafael Devers,3B,BOS,3800,3.0,10.0,20.0,12.0,3
Alex Bregman,3B,HOU,3800,3.0,10.0,20.0,11.0,5
Max Muncy,3B,LAD,3400,2.6,8.5,17.0,8.0,5
Austin Riley,3B,ATL,3600,2.9,9.5,19.0,10.0,4
Jose Ramirez,3B,CLE,3800,3.0,10.0,20.0,13.0,3
Xander Bogaerts,SS,BOS,3400,2.6,8.5,17.0,8.0,6
Jeremy Pena,SS,HOU,3400,2.6,8.5,17.0,7.0,6
Dansby Swanson,SS,ATL,3200,2.4,8.0,16.0,7.0,5
Gavin Lux,SS,LAD,3200,2.3,7.5,15.0,5.0,6
Trea Turner,SS,PHI,3800,2.9,9.5,19.0,11.0,1
Francisco Lindor,SS,NYM,4000,3.2,10.5,21.0,13.0,3
Juan Soto,OF,NYY,4200,3.6,12.0,24.0,16.0,3
Aaron Judge,OF,NYY,4000,3.5,11.5,23.0,15.0,2
Jarren Duran,OF,BOS,3600,2.7,9.0,18.0,8.0,1
Yordan Alvarez,OF,HOU,4200,3.8,12.5,25.0,18.0,3
Kyle Tucker,OF,HOU,3800,3.2,10.5,21.0,14.0,4
Ronald Acuna Jr,OF,ATL,4400,3.9,13.0,26.0,20.0,1
Steven Kwan,OF,CLE,3400,2.6,8.5,17.0,9.0,1
Mookie Betts,OF,LAD,4200,3.8,12.5,25.0,18.0,1
`,
  stacks3Csv: `Team,Salary,Proj,b0,b1,b2
NYY,11800,32.5,Juan Soto,Aaron Judge,Gleyber Torres
NYY,11000,29.5,Juan Soto,Aaron Judge,Anthony Rizzo
BOS,10600,27.0,Jarren Duran,Rafael Devers,Xander Bogaerts
BOS,10200,24.5,Jarren Duran,Triston Casas,Rafael Devers
HOU,11800,33.0,Yordan Alvarez,Kyle Tucker,Jose Altuve
HOU,11400,31.5,Yordan Alvarez,Alex Bregman,Jose Altuve
CLE,11000,27.5,Jose Ramirez,Steven Kwan,Andres Gimenez
CLE,10600,25.0,Jose Ramirez,Josh Naylor,Andres Gimenez
LAD,12400,33.5,Mookie Betts,Freddie Freeman,Max Muncy
LAD,11400,30.5,Mookie Betts,Freddie Freeman,Gavin Lux
ATL,12600,34.0,Ronald Acuna Jr,Matt Olson,Ozzie Albies
ATL,12200,30.5,Ronald Acuna Jr,Austin Riley,Dansby Swanson
`,
  stacks5Csv: `Team,Salary,Proj,b0,b1,b2,b3,b4
BOS,17400,44.0,Jarren Duran,Rafael Devers,Triston Casas,Kike Hernandez,Xander Bogaerts
HOU,20200,53.0,Yordan Alvarez,Kyle Tucker,Jose Altuve,Alex Bregman,Jeremy Pena
LAD,19200,48.5,Mookie Betts,Freddie Freeman,Max Muncy,Miguel Vargas,Gavin Lux
ATL,20000,51.0,Ronald Acuna Jr,Matt Olson,Austin Riley,Ozzie Albies,Dansby Swanson
`,
};

module.exports = {
  writeTempCSV,
  uploadFiles,
  smallSlateFixture,
  richPortfolioFixture,
};