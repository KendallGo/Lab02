// --- CONFIGURACIÓN Y ESTADO ---
const API_BASE = 'https://worldcup26.ir';

if (!localStorage.getItem('jwt_token')) {
    localStorage.setItem('jwt_token', 'mock_token_123');
}

// Utilidad estricta para pausas asíncronas
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Generador de color fijo basado en el ID del equipo para la tematización
function getTeamColor(teamId) {
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    const index = parseInt(teamId, 36) % colors.length;
    return colors[index || 0];
}

// --------------------------------------------------------
// 1. NÚCLEO DE RESILIENCIA GLOBAL
// --------------------------------------------------------
async function fetchWithResilience(endpoint, attempt = 1) {
    const url = `${API_BASE}${endpoint}`;
    const token = localStorage.getItem('jwt_token');
    const delay = Math.pow(2, attempt - 1) * 1000; // Backoff exponencial

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const rawData = await response.json();
            // Normalizar extracción 
            const keyName = endpoint.split('/').pop();
            const data = rawData[keyName] || rawData; 
            
            localStorage.setItem(`cache_${endpoint}`, JSON.stringify(data));
            if (navigator.onLine) {
                document.getElementById('offline-indicator').classList.add('hidden');
            }
            return data;
        }

        // Manejo de errores
        if (response.status === 401) {
            localStorage.removeItem('jwt_token');
            document.getElementById('auth-modal').classList.remove('hidden'); // Sin reload
            throw new Error("401");
        }

        if (response.status === 429 && attempt <= 4) {
            await handleCountdown429(delay / 1000);
            return await fetchWithResilience(endpoint, attempt + 1);
        }

        if (response.status === 500 && attempt <= 4) {
            console.warn(`Error 500. Reintento en ${delay}ms...`);
            await sleep(delay);
            return await fetchWithResilience(endpoint, attempt + 1);
        }

        throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        // Recuperación desde caché para modo offline
        const cached = localStorage.getItem(`cache_${endpoint}`);
        if (cached) {
            document.getElementById('offline-indicator').classList.remove('hidden');
            return JSON.parse(cached);
        }
        throw error;
    }
}

async function handleCountdown429(seconds) {
    const indicator = document.getElementById('countdown-indicator');
    const span = document.getElementById('countdown-seconds');
    indicator.classList.remove('hidden');
    for (let i = seconds; i > 0; i--) {
        span.textContent = i;
        await sleep(1000);
    }
    indicator.classList.add('hidden');
}

// --------------------------------------------------------
// 2.1 TOUR VIRTUAL DE SEDES
// --------------------------------------------------------
async function initTour() {
    const container = document.getElementById('stadiums-container');
    try {
        const stadiums = await fetchWithResilience('/get/stadiums');
        container.innerHTML = '';

        stadiums.forEach(st => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `<h3>${st.name_en || st.name}</h3><p class="text-muted">${st.city_en || st.city}</p>`;
            
            card.addEventListener('click', async () => {
                document.querySelectorAll('#view-tour .card').forEach(c => c.classList.remove('active'));
                card.classList.add('active'); // Estado visual
                document.getElementById('games-section').scrollIntoView({ behavior: 'smooth' }); // Scroll
                await loadGamesForTour(st.id);
            });
            container.appendChild(card);
        });
    } catch (e) {
        container.innerHTML = '<div class="error-box">Fallo crítico al cargar sedes.</div>';
    }
}

async function loadGamesForTour(stadiumId) {
    const container = document.getElementById('games-container');
    container.innerHTML = '<p class="text-muted">Cargando...</p>';
    try {
        const [games, teams] = await Promise.all([
            fetchWithResilience('/get/games'),
            fetchWithResilience('/get/teams')
        ]);
        
        const filtered = games.filter(g => String(g.stadium_id) === String(stadiumId));
        container.innerHTML = filtered.length ? '' : '<p class="text-muted">Sin partidos.</p>';
        
        filtered.forEach(g => {
            const tHome = teams.find(t => String(t.id) === String(g.home_team_id));
            const tAway = teams.find(t => String(t.id) === String(g.away_team_id));
            const home = tHome?.name_en || 'Por definir';
            const away = tAway?.name_en || 'Por definir';
            const flagH = tHome?.flag ? `<img src="${tHome.flag}" class="flag-icon" alt="">` : '';
            const flagA = tAway?.flag ? `<img src="${tAway.flag}" class="flag-icon" alt="">` : '';
            container.insertAdjacentHTML('beforeend', `<div class="card no-hover"><h3 class="team-name">${home} ${flagH} vs ${flagA} ${away}</h3><p class="text-muted">Fecha: ${g.local_date} | Partido ${g.id || g.game_id}</p></div>`);
        });
    } catch (e) {
        // Resiliencia local
        container.innerHTML = '<div class="error-box">No se pudieron cargar los partidos.</div>';
    }
}

// --------------------------------------------------------
// 2.2 AGENDA SIMULTÁNEA
// --------------------------------------------------------
let agendaDates = [];
let currentAgendaIndex = 0;

async function initAgenda() {
    const container = document.getElementById('agenda-container');
    const labelDate = document.getElementById('agenda-current-date');
    container.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; // Layout dividido
    
    try {
        const [games, teams] = await Promise.all([
            fetchWithResilience('/get/games'),
            fetchWithResilience('/get/teams')
        ]);
        
        const grouped = {};
        games.forEach(g => {
            if (!grouped[g.local_date]) grouped[g.local_date] = [];
            grouped[g.local_date].push(g);
        });

        agendaDates = Object.keys(grouped).filter(date => grouped[date].length >= 2).sort();
        if (agendaDates.length === 0) throw new Error("No hay simultáneos");
        
        document.getElementById('btn-prev-date').onclick = () => { if (currentAgendaIndex > 0) { currentAgendaIndex--; renderAgendaDate(grouped, teams); } };
        document.getElementById('btn-next-date').onclick = () => { if (currentAgendaIndex < agendaDates.length - 1) { currentAgendaIndex++; renderAgendaDate(grouped, teams); } };
        
        renderAgendaDate(grouped, teams);
    } catch (e) {
        labelDate.textContent = "Error de red";
    }
}

async function renderAgendaDate(grouped, teams) {
    const date = agendaDates[currentAgendaIndex];
    document.getElementById('agenda-current-date').textContent = date;
    const container = document.getElementById('agenda-container');
    container.innerHTML = '';
    
    grouped[date].forEach(g => {
        const tHome = teams.find(t => String(t.id) === String(g.home_team_id));
        const tAway = teams.find(t => String(t.id) === String(g.away_team_id));
        const home = tHome?.name_en || 'TBD';
        const away = tAway?.name_en || 'TBD';
        const flagH = tHome?.flag ? `<img src="${tHome.flag}" class="flag-icon" alt="">` : '';
        const flagA = tAway?.flag ? `<img src="${tAway.flag}" class="flag-icon" alt="">` : '';
        const subtitle = (g.finished === "TRUE" || g.home_score !== null) 
            ? `Resultado: ${g.home_score} - ${g.away_score}` 
            : `Pendiente`;
        container.insertAdjacentHTML('beforeend', `<div class="card no-hover"><h3 class="team-name">${home} ${flagH} vs ${flagA} ${away}</h3><p class="text-muted">${subtitle}</p></div>`);
    });
}

// --------------------------------------------------------
// 2.3 TIMELINE INFINITO
// --------------------------------------------------------
let timelineGames = [];
let timelineTeams = [];
let timelineIndex = 0;
let observer;

async function initTimeline() {
    document.getElementById('btn-retry-timeline').onclick = async () => {
        document.getElementById('timeline-error').classList.add('hidden');
        await fetchTimelineData();
    };
    if (timelineGames.length === 0) await fetchTimelineData();
}

async function fetchTimelineData() {
    try {
        timelineTeams = await fetchWithResilience('/get/teams');
        const games = await fetchWithResilience('/get/games');
        timelineGames = games.sort((a, b) => new Date(a.local_date) - new Date(b.local_date)); // Orden cronológico
        
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) renderTimelineBatch(); // Observer
        });
        observer.observe(document.getElementById('timeline-sentinel'));
    } catch (e) {
        document.getElementById('timeline-error').classList.remove('hidden'); // Reto de resiliencia
    }
}

function renderTimelineBatch() {
    const container = document.getElementById('timeline-container');
    const limit = Math.min(timelineIndex + 10, timelineGames.length);
    
    for (let i = timelineIndex; i < limit; i++) {
        const g = timelineGames[i];
        const tHome = timelineTeams.find(t => String(t.id) === String(g.home_team_id));
        const tAway = timelineTeams.find(t => String(t.id) === String(g.away_team_id));
        const home = tHome?.name_en || 'TBD';
        const away = tAway?.name_en || 'TBD';
        const flagH = tHome?.flag ? `<img src="${tHome.flag}" class="flag-icon" alt="">` : '';
        const flagA = tAway?.flag ? `<img src="${tAway.flag}" class="flag-icon" alt="">` : '';
        container.insertAdjacentHTML('beforeend', `<div class="card no-hover"><h3 class="team-name">${home} ${flagH} vs ${flagA} ${away}</h3><p class="text-muted">${g.local_date}</p></div>`);
    }
    timelineIndex = limit;
    if (timelineIndex >= timelineGames.length) observer.disconnect();
}

// --------------------------------------------------------
// 2.4 DASHBOARD DEL FANÁTICO
// --------------------------------------------------------
async function initDashboard() {
    const selector = document.getElementById('team-selector');
    try {
        const teams = await fetchWithResilience('/get/teams');
        selector.innerHTML = '<option value="">Selecciona tu equipo...</option>';
        
        teams.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name_en || t.name;
            selector.appendChild(opt);
        });

        const savedTeam = localStorage.getItem('fav_team'); // Persistencia
        if (savedTeam) {
            selector.value = savedTeam;
            await updateDashboard(savedTeam, teams);
        }

        selector.onchange = async (e) => {
            localStorage.setItem('fav_team', e.target.value);
            await updateDashboard(e.target.value, teams);
        };
    } catch (e) {
        console.error("Fallo inicial Dashboard");
    }
}

async function updateDashboard(teamId, allTeams) {
    if (!teamId) return;
    const myTeam = allTeams.find(t => String(t.id) === String(teamId));
    
    // Asignar color fijo del equipo
    document.documentElement.style.setProperty('--theme-color', getTeamColor(teamId));
    
    // Mostrar bandera
    if (myTeam) {
        document.getElementById('dash-team-info').classList.remove('hidden');
        document.getElementById('dash-team-flag').src = myTeam.flag || '';
        document.getElementById('dash-team-name').textContent = myTeam.name_en || myTeam.name;
    } else {
        document.getElementById('dash-team-info').classList.add('hidden');
    }

    try {
        // Cruzar los 3 endpoints exigidos
        const [games, groups] = await Promise.all([
            fetchWithResilience('/get/games'),
            fetchWithResilience('/get/groups') 
        ]);
        
        const teamGames = games.filter(g => String(g.home_team_id) === String(teamId) || String(g.away_team_id) === String(teamId));
        
        const container = document.getElementById('dash-games-container');
        container.innerHTML = '';
        
        let myPts = 0; let myGf = 0; let myGa = 0;
        
        teamGames.forEach(g => {
            const tHome = allTeams.find(t => String(t.id) === String(g.home_team_id));
            const tAway = allTeams.find(t => String(t.id) === String(g.away_team_id));
            const home = tHome?.name_en || 'TBD';
            const away = tAway?.name_en || 'TBD';
            const flagH = tHome?.flag ? `<img src="${tHome.flag}" class="flag-icon" alt="">` : '';
            const flagA = tAway?.flag ? `<img src="${tAway.flag}" class="flag-icon" alt="">` : '';
            let scoreText = "Pendiente";

            if (g.home_score !== undefined && g.away_score !== undefined && g.home_score !== null) {
                scoreText = `${g.home_score} - ${g.away_score}`;
                
                const isHome = String(g.home_team_id) === String(teamId);
                const tScore = parseInt(isHome ? g.home_score : g.away_score, 10);
                const rScore = parseInt(isHome ? g.away_score : g.home_score, 10);
                
                myGf += tScore;
                myGa += rScore;
                
                if (tScore > rScore) myPts += 3;
                else if (tScore === rScore) myPts += 1;
            }

            container.insertAdjacentHTML('beforeend', `<div class="card theme-card no-hover">
                <h3 class="team-name">${home} ${flagH} vs ${flagA} ${away}</h3>
                <p class="text-muted">Fecha: ${g.local_date} | Resultado: ${scoreText}</p>
            </div>`);
        });

        // Imprimir Puntos y Goles a favor
        document.getElementById('dash-pts').textContent = myPts;
        document.getElementById('dash-gf').textContent = myGf;

// --- CÁLCULO DE POSICIÓN CON LA LLAVE REAL ---
        const myTeam = allTeams.find(t => String(t.id) === String(teamId));
        
        // Extraer la letra del grupo usando la llave exacta de la API
        const groupLetter = myTeam?.groups; 

        if (groupLetter) {
            // Filtrar a los 4 equipos que comparten exactamente esta letra
            const groupTeams = allTeams.filter(t => String(t.groups) === String(groupLetter));
            
            const groupStats = groupTeams.map(team => {
                let pts = 0, gf = 0, ga = 0;
                const tGames = games.filter(g => String(g.home_team_id) === String(team.id) || String(g.away_team_id) === String(team.id));
                
                tGames.forEach(g => {
                    if (g.home_score !== undefined && g.away_score !== undefined && g.home_score !== null) {
                        const isHome = String(g.home_team_id) === String(team.id);
                        const tScore = parseInt(isHome ? g.home_score : g.away_score, 10);
                        const rScore = parseInt(isHome ? g.away_score : g.home_score, 10);
                        
                        gf += tScore;
                        ga += rScore;
                        if (tScore > rScore) pts += 3;
                        else if (tScore === rScore) pts += 1;
                    }
                });
                return { id: team.id, pts, gf, gd: gf - ga };
            });

            // Ordenamiento estricto: Puntos > Diferencia de Goles > Goles a Favor
            groupStats.sort((a, b) => {
                if (b.pts !== a.pts) return b.pts - a.pts;
                if (b.gd !== a.gd) return b.gd - a.gd;
                return b.gf - a.gf;
            });

            // Asignar posición real (índice + 1)
            const realPosition = groupStats.findIndex(t => String(t.id) === String(teamId)) + 1;
            document.getElementById('dash-pos').textContent = realPosition;
        } else {
            document.getElementById('dash-pos').textContent = "-";
        }

    } catch (e) {
        console.warn("Manejando caché offline del dashboard", e);
    }
}

// --- 2.5 MATRIZ DE ENFRENTAMIENTOS ---
async function initMatriz() {
    const container = document.getElementById('matriz-container');
    container.innerHTML = ''; // Limpieza inicial permitida
    
    let groups = [], teams = [], games = [];
    let isGamesFailed = false;

    try {
        groups = await fetchWithResilience('/get/groups'); // Se consumen los 3 endpoints exigidos
        const dataTeams = await fetchWithResilience('/get/teams');
        teams = dataTeams.teams || dataTeams;
    } catch(e) {
        container.innerHTML = '<div class="error-box">Error al cargar grupos y equipos.</div>';
        return;
    }

    try {
        const dataGames = await fetchWithResilience('/get/games');
        games = dataGames.games || dataGames;
    } catch(e) {
        isGamesFailed = true; 
    }

    const groupLetters = [...new Set(teams.map(t => t.groups))].filter(Boolean).sort();

    groupLetters.forEach(letter => {
        const groupObj = (groups.groups || groups).find(g => String(g.name_en || g.name || g.id) === String(letter));
        const groupTitle = groupObj ? (groupObj.name_en || groupObj.name) : `Grupo ${letter}`;
        const groupTeams = teams.filter(t => String(t.groups) === String(letter)).slice(0, 4);
        if(groupTeams.length === 0) return;

        let html = `<table class="matrix-table"><tr><th>${groupTitle}</th>`;
        groupTeams.forEach(t => html += `<th>${t.name_en || t.name}</th>`);
        html += `</tr>`;

        groupTeams.forEach((teamA, i) => {
            html += `<tr><th>${teamA.name_en || teamA.name}</th>`;
            groupTeams.forEach((teamB, j) => {
                if (i === j) {
                    html += `<td class="matrix-disabled">X</td>`; 
                } else {
                    // INYECCION LOS IDs EN EL DOM PARA ACTUALIZAR SIN RECONSTRUIR
                    const matchId = `${teamA.id}-${teamB.id}`;
                    
                    if (isGamesFailed) {
                        html += `<td data-match="${matchId}" class="match-cell">Pendiente</td>`;
                    } else {
                        const game = games.find(g => 
                            (String(g.home_team_id) === String(teamA.id) && String(g.away_team_id) === String(teamB.id)) ||
                            (String(g.home_team_id) === String(teamB.id) && String(g.away_team_id) === String(teamA.id))
                        );

                        if (game && game.home_score !== null && game.home_score !== undefined) {
                            const scoreA = String(game.home_team_id) === String(teamA.id) ? game.home_score : game.away_score;
                            const scoreB = String(game.home_team_id) === String(teamA.id) ? game.away_score : game.home_score;
                            html += `<td data-match="${matchId}" class="match-cell">${scoreA} - ${scoreB}</td>`;
                        } else {
                            html += `<td data-match="${matchId}" class="match-cell">Pendiente</td>`;
                        }
                    }
                }
            });
            html += `</tr>`;
        });
        html += `</table>`;
        container.insertAdjacentHTML('beforeend', html);
    });

    if(isGamesFailed) {
        // Agregamos un botón para disparar la recuperación de datos sin tocar la tabla
        container.insertAdjacentHTML('afterbegin', `
            <div id="matriz-error-bar" class="error-box" style="margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center;">
                <span>Aviso: Resultados no disponibles. Matrices en estado Pendiente.</span>
                <button id="btn-recover-matriz" class="btn btn-danger" style="width:auto;">Reintentar Conexión</button>
            </div>
        `);
        
        document.getElementById('btn-recover-matriz').addEventListener('click', recoverMatrizGames);
    }
}

// Actualiza solo celdas afectadas, respetando la regla
async function recoverMatrizGames() {
    try {
        const btn = document.getElementById('btn-recover-matriz');
        btn.textContent = "Conectando...";
        btn.disabled = true;

        const dataGames = await fetchWithResilience('/get/games');
        const games = dataGames.games || dataGames;

        // Iteramos exclusivamente sobre las celdas, sin destruir el innerHTML
        document.querySelectorAll('.match-cell').forEach(cell => {
            const [idA, idB] = cell.dataset.match.split('-');
            const game = games.find(g => 
                (String(g.home_team_id) === String(idA) && String(g.away_team_id) === String(idB)) ||
                (String(g.home_team_id) === String(idB) && String(g.away_team_id) === String(idA))
            );

            if (game && game.home_score !== null && game.home_score !== undefined) {
                const scoreA = String(game.home_team_id) === String(idA) ? game.home_score : game.away_score;
                const scoreB = String(game.home_team_id) === String(idA) ? game.away_score : game.home_score;
                cell.textContent = `${scoreA} - ${scoreB}`; // Actualización puntual
            }
        });

        document.getElementById('matriz-error-bar').remove(); // Quitar la alerta
    } catch (error) {
        document.getElementById('btn-recover-matriz').textContent = "Falló. Reintentar";
        document.getElementById('btn-recover-matriz').disabled = false;
    }
}

// --------------------------------------------------------
// GESTIÓN DE PESTAÑAS (SPA) E INICIO
// --------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
        
        e.target.classList.add('active');
        const targetId = e.target.getAttribute('data-target');
        document.getElementById(targetId).classList.remove('hidden');

        if (targetId === 'view-tour') await initTour();
        if (targetId === 'view-agenda') await initAgenda();
        if (targetId === 'view-timeline') await initTimeline();
        if (targetId === 'view-dashboard') await initDashboard();
        if (targetId === 'view-matriz') await initMatriz();
    });
});

document.getElementById('btn-reauth').addEventListener('click', async () => {
    localStorage.setItem('jwt_token', 'nuevo_token_valido_456');
    document.getElementById('auth-modal').classList.add('hidden');
    await initTour(); 
});

// Inicializar la primera vista
initTour();

// Listeners globales para estado de conexión
window.addEventListener('offline', () => {
    document.getElementById('offline-indicator').classList.remove('hidden');
});
window.addEventListener('online', () => {
    document.getElementById('offline-indicator').classList.add('hidden');
});

// Comprobar estado inicial al cargar o cambiar pestañas si ya estaba offline
if (!navigator.onLine) {
    document.getElementById('offline-indicator').classList.remove('hidden');
}