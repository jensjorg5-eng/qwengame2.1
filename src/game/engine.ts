import * as THREE from 'three';
import { CONFIG } from './config';
import { SeededRandom } from './prng';

// ============================================================
// TYPES
// ============================================================
interface Entity {
  id: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  mesh?: THREE.Object3D;
  active: boolean;
}

interface PlayerState extends Entity {
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  cash: number;
  heat: number;
  heatDecayTimer: number;
  hasGlider: boolean;
  hasTether: boolean;
  tetherRange: number;
  isClimbing: boolean;
  isGliding: boolean;
  isDodging: boolean;
  dodgeTimer: number;
  dodgeDir: THREE.Vector3;
  meleeCooldown: number;
  lockOnTarget: Entity | null;
  inVehicle: Vehicle | null;
  isWet: boolean;
  abilities: string[];
}

interface Vehicle extends Entity {
  type: 'sport' | 'suv' | 'truck' | 'police';
  speed: number;
  maxSpeed: number;
  accel: number;
  health: number;
  occupied: boolean;
  driverNPC: NPC | null;
  rotation: number;
  isWrecked: boolean;
  isMetal: boolean;
  tethered: boolean;
}

interface NPC extends Entity {
  type: 'pedestrian' | 'driver' | 'police' | 'bandit';
  state: 'wander' | 'flee' | 'witness' | 'pursue' | 'attack' | 'idle' | 'dead' | 'pursue';
  health: number;
  target: THREE.Vector3 | null;
  stateTimer: number;
  roadTarget: number;
  attackCooldown: number;
}

interface Mission {
  id: string;
  title: string;
  giver: string;
  giverPos: THREE.Vector3;
  requires: { abilities: string[]; maxHeat: number };
  steps: MissionStep[];
  reward: { cash: number };
  failOn: string[];
  active: boolean;
  currentStep: number;
  timer: number;
  completed: boolean;
  failed: boolean;
}

interface MissionStep {
  type: string;
  target: string;
  targetPos?: THREE.Vector3;
  radius?: number;
  timeLimit?: number;
}

interface Shrine {
  id: string;
  position: THREE.Vector3;
  solved: boolean;
  puzzleType: string;
  mesh?: THREE.Object3D;
}

interface ShopItem {
  id: string;
  name: string;
  cost: number;
  effect: string;
  value: number;
  purchased: boolean;
}

// ============================================================
// MISSION DEFINITIONS
// ============================================================
const MISSION_DEFS = [
  {
    id: 'm1_delivery',
    title: 'Express Cargo',
    giver: 'npc_dispatcher',
    giverPos: new THREE.Vector3(50, 0, 50),
    requires: { abilities: [], maxHeat: 2 },
    steps: [
      { type: 'talk', target: 'npc_dispatcher' },
      { type: 'goto', target: 'pickup_1', targetPos: new THREE.Vector3(-100, 0, 80), radius: 5 },
      { type: 'drive_to', target: 'dropoff_1', targetPos: new THREE.Vector3(150, 0, -60), radius: 6, timeLimit: CONFIG.M1_TIME_LIMIT },
    ],
    reward: { cash: CONFIG.M1_REWARD },
    failOn: ['timeout', 'player_death', 'heat_above_max'],
  },
  {
    id: 'm2_heat_escape',
    title: 'Cool Down',
    giver: 'npc_fixer',
    giverPos: new THREE.Vector3(-80, 0, -30),
    requires: { abilities: [], maxHeat: 0 },
    steps: [
      { type: 'talk', target: 'npc_fixer' },
      { type: 'lose_heat', target: 'all', radius: 0 },
      { type: 'goto', target: 'safehouse_1', targetPos: new THREE.Vector3(-150, 0, 100), radius: 5 },
    ],
    reward: { cash: CONFIG.M2_REWARD },
    failOn: ['player_death'],
  },
  {
    id: 'm3_tether_job',
    title: 'The Big Pull',
    giver: 'npc_engineer',
    giverPos: new THREE.Vector3(200, 0, 100),
    requires: { abilities: ['tether', 'glider'], maxHeat: 3 },
    steps: [
      { type: 'talk', target: 'npc_engineer' },
      { type: 'tether_object', target: 'target_car', targetPos: new THREE.Vector3(220, 0, 90), radius: 3 },
      { type: 'goto', target: 'dropzone', targetPos: new THREE.Vector3(250, 0, 120), radius: 5 },
    ],
    reward: { cash: CONFIG.M3_REWARD },
    failOn: ['player_death'],
  },
];

// ============================================================
// GAME ENGINE
// ============================================================
export class GameEngine {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;
  private rng: SeededRandom;
  private seed: number;

  // Game state
  private player: PlayerState;
  private vehicles: Vehicle[] = [];
  private npcs: NPC[] = [];
  private missions: Mission[] = [];
  private shrines: Shrine[] = [];
  private shops: ShopItem[] = [];
  private towers: { pos: THREE.Vector3; revealed: boolean; mesh?: THREE.Object3D }[] = [];

  // World
  private terrain: THREE.Mesh | null = null;
  private buildings: THREE.Mesh[] = [];
  private roads: THREE.Mesh[] = [];
  private worldBounds = { minX: -CONFIG.WORLD_SIZE_X / 2, maxX: CONFIG.WORLD_SIZE_X / 2, minZ: -CONFIG.WORLD_SIZE_Z / 2, maxZ: CONFIG.WORLD_SIZE_Z / 2 };

  // Input
  private keys: Set<string> = new Set();
  private mouseDown = { left: false, right: false };
  private mouseDelta = { x: 0, y: 0 };
  private cameraYaw = 0;
  private cameraPitch = 0.3;
  private isPointerLocked = false;

  // Environment
  private dayTime = 0.3;
  private isRaining = false;
  private rainTimer = 0;
  private sunLight: THREE.DirectionalLight | null = null;
  private ambientLight: THREE.AmbientLight | null = null;

  // UI
  private showDebug = false;
  private showPause = true;
  private fps = 0;
  private frameCount = 0;
  private fpsTimer = 0;

  // Save
  private saveTimer = 0;

  // Tether
  private tetherTarget: Vehicle | null = null;
  private tetherActive = false;
  private tetherLine: THREE.Line | null = null;

  // Spatial grid
  private spatialGrid: Map<string, Entity[]> = new Map();
  private gridCellSize = 50;

  constructor(container: HTMLElement) {
    // Parse seed from URL
    const urlParams = new URLSearchParams(window.location.search);
    this.seed = urlParams.has('seed') ? parseInt(urlParams.get('seed')!) : CONFIG.DEFAULT_SEED;
    this.rng = new SeededRandom(this.seed);

    // Three.js setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 50, CONFIG.CULL_DISTANCE);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);

    this.clock = new THREE.Clock();

    // Initialize player
    this.player = this.createPlayer();

    // Setup world
    this.setupLighting();
    this.generateWorld();
    this.spawnNPCs();
    this.spawnVehicles();
    this.setupShrines();
    this.setupTowers();
    this.setupShop();
    this.setupMissions();
    this.setupTetherLine();

    // Add player mesh to scene and sync position
    if (this.player.mesh) {
      this.player.mesh.position.set(
        this.player.position.x,
        this.player.position.y + CONFIG.PLAYER_HEIGHT / 2,
        this.player.position.z
      );
      this.scene.add(this.player.mesh);
    }

    // Set initial camera position
    this.camera.position.set(0, CONFIG.CAM_HEIGHT + 3, CONFIG.CAM_DISTANCE);
    this.camera.lookAt(0, 1.5, 0);

    // Input handlers
    this.setupInput();

    // Load save
    this.loadGame();

    // Start loop (game starts paused, user clicks to begin)
    this.showPause = true;
    this.animate();
  }

  private createPlayer(): PlayerState {
    // Create a visible character group (body + head)
    const group = new THREE.Group();
    
    // Body
    const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 8);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2266cc });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.7;
    group.add(body);
    
    // Head
    const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xffcc88 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.4;
    group.add(head);
    
    // Arms
    const armGeo = new THREE.CapsuleGeometry(0.1, 0.5, 4, 4);
    const armMat = new THREE.MeshLambertMaterial({ color: 0x2266cc });
    const leftArm = new THREE.Mesh(armGeo, armMat);
    leftArm.position.set(-0.45, 0.8, 0);
    group.add(leftArm);
    const rightArm = new THREE.Mesh(armGeo, armMat);
    rightArm.position.set(0.45, 0.8, 0);
    group.add(rightArm);
    
    // Legs
    const legGeo = new THREE.CapsuleGeometry(0.12, 0.5, 4, 4);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x333366 });
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.15, 0.2, 0);
    group.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.15, 0.2, 0);
    group.add(rightLeg);

    return {
      id: 'player',
      position: new THREE.Vector3(0, 1, 0),
      velocity: new THREE.Vector3(),
      mesh: group,
      active: true,
      health: CONFIG.PLAYER_START_HEALTH,
      maxHealth: CONFIG.PLAYER_MAX_HEALTH,
      stamina: CONFIG.STAMINA_MAX,
      maxStamina: CONFIG.STAMINA_MAX,
      cash: 100,
      heat: 0,
      heatDecayTimer: 0,
      hasGlider: false,
      hasTether: false,
      tetherRange: CONFIG.TETHER_RANGE,
      isClimbing: false,
      isGliding: false,
      isDodging: false,
      dodgeTimer: 0,
      dodgeDir: new THREE.Vector3(),
      meleeCooldown: 0,
      lockOnTarget: null,
      inVehicle: null,
      isWet: false,
      abilities: [],
    };
  }

  private setupLighting() {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.position.set(50, 100, 50);
    this.scene.add(this.sunLight);
  }

  private generateWorld() {
    // Terrain
    const terrainGeo = new THREE.PlaneGeometry(CONFIG.WORLD_SIZE_X, CONFIG.WORLD_SIZE_Z, 64, 32);
    terrainGeo.rotateX(-Math.PI / 2);
    const positions = terrainGeo.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      let y = 0;
      // Mountain
      const dx = x - CONFIG.MOUNTAIN_POS_X;
      const dz = z - CONFIG.MOUNTAIN_POS_Z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 100) {
        y = Math.max(0, (1 - dist / 100) * CONFIG.MOUNTAIN_HEIGHT);
        // Cliffs
        if (dist > 40 && dist < 60) {
          y = Math.max(y, CONFIG.CLIFF_HEIGHT);
        }
      }
      positions.setY(i, y);
    }
    terrainGeo.computeVertexNormals();
    const terrainMat = new THREE.MeshLambertMaterial({ color: 0x55aa55 });
    this.terrain = new THREE.Mesh(terrainGeo, terrainMat);
    this.scene.add(this.terrain);

    // City roads (grid)
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    for (let x = -CONFIG.WORLD_SIZE_X / 2 + CONFIG.CITY_GRID_SIZE; x < 0; x += CONFIG.CITY_GRID_SIZE) {
      const roadGeo = new THREE.PlaneGeometry(8, CONFIG.WORLD_SIZE_Z);
      roadGeo.rotateX(-Math.PI / 2);
      const road = new THREE.Mesh(roadGeo, roadMat);
      road.position.set(x, 0.05, 0);
      this.scene.add(road);
      this.roads.push(road);
    }
    for (let z = -CONFIG.WORLD_SIZE_Z / 2 + CONFIG.CITY_GRID_SIZE; z < CONFIG.WORLD_SIZE_Z / 2; z += CONFIG.CITY_GRID_SIZE) {
      const roadGeo = new THREE.PlaneGeometry(CONFIG.WORLD_SIZE_X / 2, 8);
      roadGeo.rotateX(-Math.PI / 2);
      const road = new THREE.Mesh(roadGeo, roadMat);
      road.position.set(-CONFIG.WORLD_SIZE_X / 4, 0.05, z);
      this.scene.add(road);
      this.roads.push(road);
    }

    // Buildings
    const buildingColors = [0x888888, 0x999999, 0xaaaaaa, 0x777777];
    for (let gx = 0; gx < 8; gx++) {
      for (let gz = 0; gz < 6; gz++) {
        const baseX = -CONFIG.WORLD_SIZE_X / 2 + gx * CONFIG.CITY_GRID_SIZE + 15;
        const baseZ = -CONFIG.WORLD_SIZE_Z / 2 + gz * CONFIG.CITY_GRID_SIZE + 15;
        const numBuildings = this.rng.int(1, 4);
        for (let b = 0; b < numBuildings; b++) {
          const w = this.rng.range(6, 15);
          const d = this.rng.range(6, 15);
          const h = this.rng.range(CONFIG.BUILDING_MIN_HEIGHT, CONFIG.BUILDING_MAX_HEIGHT);
          const bx = baseX + this.rng.range(-10, 10);
          const bz = baseZ + this.rng.range(-10, 10);
          const geo = new THREE.BoxGeometry(w, h, d);
          const mat = new THREE.MeshLambertMaterial({ color: this.rng.pick(buildingColors) });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(bx, h / 2, bz);
          this.scene.add(mesh);
          this.buildings.push(mesh);
        }
      }
    }
  }

  private spawnNPCs() {
    // Pedestrians
    for (let i = 0; i < CONFIG.NPC_COUNT_PED; i++) {
      const npc = this.createNPC('pedestrian');
      npc.position.set(this.rng.range(-200, 0), 0, this.rng.range(-CONFIG.WORLD_SIZE_Z / 2, CONFIG.WORLD_SIZE_Z / 2));
      if (npc.mesh) npc.mesh.position.set(npc.position.x, 1, npc.position.z);
      this.npcs.push(npc);
    }

    // Traffic
    for (let i = 0; i < CONFIG.NPC_COUNT_TRAFFIC; i++) {
      const npc = this.createNPC('driver');
      npc.position.set(this.rng.range(-200, 0), 0, this.rng.range(-CONFIG.WORLD_SIZE_Z / 2, CONFIG.WORLD_SIZE_Z / 2));
      npc.roadTarget = this.rng.int(0, this.roads.length);
      if (npc.mesh) npc.mesh.position.set(npc.position.x, 1, npc.position.z);
      this.npcs.push(npc);
    }

    // Bandits in wilderness
    for (let i = 0; i < 5; i++) {
      const npc = this.createNPC('bandit');
      npc.position.set(this.rng.range(100, 300), 0, this.rng.range(-100, 100));
      if (npc.mesh) npc.mesh.position.set(npc.position.x, 1, npc.position.z);
      this.npcs.push(npc);
    }
  }

  private createNPC(type: NPC['type']): NPC {
    // Create a visible character group
    const group = new THREE.Group();
    
    const bodyColor = type === 'police' ? 0x000088 : type === 'bandit' ? 0x880000 : 0xdd8800;
    const headColor = 0xffcc88;
    
    // Body
    const bodyGeo = new THREE.CapsuleGeometry(0.3, 0.7, 4, 8);
    const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.65;
    group.add(body);
    
    // Head
    const headGeo = new THREE.SphereGeometry(0.2, 8, 8);
    const headMat = new THREE.MeshLambertMaterial({ color: headColor });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.25;
    group.add(head);
    
    // Police hat
    if (type === 'police') {
      const hatGeo = new THREE.CylinderGeometry(0.15, 0.2, 0.15, 8);
      const hatMat = new THREE.MeshLambertMaterial({ color: 0x000044 });
      const hat = new THREE.Mesh(hatGeo, hatMat);
      hat.position.y = 1.45;
      group.add(hat);
    }
    
    // Bandit mask
    if (type === 'bandit') {
      const maskGeo = new THREE.BoxGeometry(0.3, 0.1, 0.1);
      const maskMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
      const mask = new THREE.Mesh(maskGeo, maskMat);
      mask.position.set(0, 1.25, 0.15);
      group.add(mask);
    }
    
    this.scene.add(group);

    return {
      id: `npc_${type}_${this.npcs.length}`,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      mesh: group,
      active: true,
      type,
      state: 'wander',
      health: type === 'bandit' ? CONFIG.ENEMY_HEALTH : 2,
      target: null,
      stateTimer: 0,
      roadTarget: 0,
      attackCooldown: 0,
    };
  }

  private spawnVehicles() {
    const types: Vehicle['type'][] = ['sport', 'suv', 'truck'];
    for (let i = 0; i < 12; i++) {
      const v = this.createVehicle(this.rng.pick(types));
      v.position.set(this.rng.range(-200, 50), 0, this.rng.range(-CONFIG.WORLD_SIZE_Z / 2, CONFIG.WORLD_SIZE_Z / 2));
      if (v.mesh) {
        v.mesh.position.set(v.position.x, 0.8, v.position.z);
        v.rotation = this.rng.range(0, Math.PI * 2);
        v.mesh.rotation.y = v.rotation;
      }
      this.vehicles.push(v);
    }
  }

  private createVehicle(type: Vehicle['type']): Vehicle {
    const colors = { sport: 0xff0000, suv: 0x00aa00, truck: 0x884400, police: 0x0000ff };
    const group = new THREE.Group();
    
    // Car body
    const bodyGeo = new THREE.BoxGeometry(2, 0.8, 4);
    const bodyMat = new THREE.MeshLambertMaterial({ color: colors[type] });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.5;
    group.add(body);
    
    // Car roof/cabin
    const roofGeo = new THREE.BoxGeometry(1.6, 0.6, 2);
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 1.1;
    roof.position.z = -0.3;
    group.add(roof);
    
    // Wheels
    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const wheelPositions = [
      [-0.9, 0.3, 1.2], [0.9, 0.3, 1.2],
      [-0.9, 0.3, -1.2], [0.9, 0.3, -1.2]
    ];
    for (const [x, y, z] of wheelPositions) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      group.add(wheel);
    }
    
    // Police lights
    if (type === 'police') {
      const lightGeo = new THREE.BoxGeometry(0.8, 0.2, 0.3);
      const lightMat = new THREE.MeshLambertMaterial({ color: 0xff0000, emissive: 0xff0000 });
      const light = new THREE.Mesh(lightGeo, lightMat);
      light.position.y = 1.5;
      group.add(light);
    }
    
    this.scene.add(group);
    const mesh = group;

    const speeds = {
      sport: { top: CONFIG.VEHICLE_SPORT_TOP_SPEED, accel: CONFIG.VEHICLE_SPORT_ACCEL },
      suv: { top: CONFIG.VEHICLE_SUV_TOP_SPEED, accel: CONFIG.VEHICLE_SUV_ACCEL },
      truck: { top: CONFIG.VEHICLE_TRUCK_TOP_SPEED, accel: CONFIG.VEHICLE_TRUCK_ACCEL },
      police: { top: CONFIG.HEAT_POLICE_PURSUIT_SPEED, accel: CONFIG.VEHICLE_ACCEL },
    };

    return {
      id: `vehicle_${type}_${this.vehicles.length}`,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      mesh,
      active: true,
      type,
      speed: 0,
      maxSpeed: speeds[type].top,
      accel: speeds[type].accel,
      health: CONFIG.VEHICLE_WRECK_HEALTH,
      occupied: type === 'suv' || type === 'truck' ? this.rng.chance(0.3) : false,
      driverNPC: null,
      rotation: 0,
      isWrecked: false,
      isMetal: true,
      tethered: false,
    };
  }

  private setupShrines() {
    // Shrine 1: Glider - accessible at ground level, has a pressure plate puzzle
    // Puzzle: Stand on the plate (within 2m) for 2 seconds to solve
    const shrine1Geo = new THREE.BoxGeometry(8, 5, 8);
    const shrine1Mat = new THREE.MeshLambertMaterial({ color: 0xffdd00 });
    const shrine1Mesh = new THREE.Mesh(shrine1Geo, shrine1Mat);
    shrine1Mesh.position.set(CONFIG.SHRINE_1_POS_X, 2.5, CONFIG.SHRINE_1_POS_Z);
    this.scene.add(shrine1Mesh);
    // Pressure plate
    const plate1Geo = new THREE.CylinderGeometry(2, 2, 0.2, 16);
    const plate1Mat = new THREE.MeshLambertMaterial({ color: 0xffff00 });
    const plate1 = new THREE.Mesh(plate1Geo, plate1Mat);
    plate1.position.set(CONFIG.SHRINE_1_POS_X, 0.1, CONFIG.SHRINE_1_POS_Z + 6);
    this.scene.add(plate1);
    this.shrines.push({
      id: 'shrine_glider',
      position: new THREE.Vector3(CONFIG.SHRINE_1_POS_X, 0, CONFIG.SHRINE_1_POS_Z + 6),
      solved: false,
      puzzleType: 'glider',
      mesh: shrine1Mesh,
    });

    // Shrine 2: Tether - on mountain cliff at 35m+, requires glider to reach
    // The mountain cliff is at 40m height, shrine entrance is at 35m
    // Player must glide from mountain top to reach this platform
    const shrine2Geo = new THREE.BoxGeometry(8, 5, 8);
    const shrine2Mat = new THREE.MeshLambertMaterial({ color: 0x00ddff });
    const shrine2Mesh = new THREE.Mesh(shrine2Geo, shrine2Mat);
    shrine2Mesh.position.set(CONFIG.SHRINE_2_POS_X, CONFIG.SHRINE_2_MIN_HEIGHT + 2.5, CONFIG.SHRINE_2_POS_Z);
    this.scene.add(shrine2Mesh);
    // Platform to land on
    const plat2Geo = new THREE.BoxGeometry(12, 1, 12);
    const plat2Mat = new THREE.MeshLambertMaterial({ color: 0x8888ff });
    const plat2 = new THREE.Mesh(plat2Geo, plat2Mat);
    plat2.position.set(CONFIG.SHRINE_2_POS_X, CONFIG.SHRINE_2_MIN_HEIGHT, CONFIG.SHRINE_2_POS_Z);
    this.scene.add(plat2);
    this.shrines.push({
      id: 'shrine_tether',
      position: new THREE.Vector3(CONFIG.SHRINE_2_POS_X, CONFIG.SHRINE_2_MIN_HEIGHT + 1, CONFIG.SHRINE_2_POS_Z),
      solved: false,
      puzzleType: 'tether',
      mesh: shrine2Mesh,
    });
  }

  private setupTowers() {
    const towerPositions = [
      new THREE.Vector3(-50, 0, 0),
      new THREE.Vector3(100, 0, 50),
      new THREE.Vector3(250, 0, -50),
    ];
    for (const pos of towerPositions) {
      const geo = new THREE.CylinderGeometry(2, 3, CONFIG.TOWER_CLIMB_HEIGHT, 8);
      const mat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.position.y = CONFIG.TOWER_CLIMB_HEIGHT / 2;
      this.scene.add(mesh);
      this.towers.push({ pos, revealed: false, mesh });
    }
  }

  private setupShop() {
    this.shops = [
      { id: 'health_up', name: 'Heart Container', cost: CONFIG.SHOP_UPGRADE_HEALTH_COST, effect: 'health', value: CONFIG.SHOP_UPGRADE_HEALTH_VALUE, purchased: false },
      { id: 'stamina_up', name: 'Stamina Vessel', cost: CONFIG.SHOP_UPGRADE_STAMINA_COST, effect: 'stamina', value: CONFIG.SHOP_UPGRADE_STAMINA_VALUE, purchased: false },
      { id: 'tether_range', name: 'Tether Amplifier', cost: CONFIG.SHOP_UPGRADE_TETHER_COST, effect: 'tether_range', value: CONFIG.SHOP_UPGRADE_TETHER_RANGE_ADD, purchased: false },
    ];
    // Shop building visual
    const shopGeo = new THREE.BoxGeometry(8, 5, 8);
    const shopMat = new THREE.MeshLambertMaterial({ color: 0x00ff88 });
    const shopMesh = new THREE.Mesh(shopGeo, shopMat);
    shopMesh.position.set(CONFIG.SHOP_POS_X, 2.5, CONFIG.SHOP_POS_Z);
    this.scene.add(shopMesh);
  }

  private setupMissions() {
    this.missions = MISSION_DEFS.map(def => ({
      ...def,
      giverPos: def.giverPos.clone(),
      steps: def.steps.map(s => ({ ...s, targetPos: s.targetPos?.clone() })),
      active: false,
      currentStep: 0,
      timer: 0,
      completed: false,
      failed: false,
    }));
    // Mission giver markers
    for (const m of this.missions) {
      const markerGeo = new THREE.ConeGeometry(1, 2, 4);
      const markerMat = new THREE.MeshLambertMaterial({ color: 0xff8800 });
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.copy(m.giverPos);
      marker.position.y = 3;
      marker.rotation.x = Math.PI;
      this.scene.add(marker);
      // NPC at giver location
      const npcGeo = new THREE.CapsuleGeometry(0.4, 1.2, 4, 8);
      const npcMat = new THREE.MeshLambertMaterial({ color: 0xff8800 });
      const npcMesh = new THREE.Mesh(npcGeo, npcMat);
      npcMesh.position.copy(m.giverPos);
      npcMesh.position.y = 1;
      this.scene.add(npcMesh);
    }
  }

  private setupTetherLine() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(6);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x00ffff });
    this.tetherLine = new THREE.Line(geo, mat);
    this.tetherLine.visible = false;
    this.scene.add(this.tetherLine);
  }

  private setupInput() {
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyF' && !e.repeat) {
        this.showDebug = !this.showDebug;
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown.left = true;
      if (e.button === 2) this.mouseDown.right = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown.left = false;
      if (e.button === 2) this.mouseDown.right = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.isPointerLocked) {
        this.mouseDelta.x += e.movementX;
        this.mouseDelta.y += e.movementY;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.renderer.domElement;
      this.showPause = !this.isPointerLocked;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    this.renderer.domElement.addEventListener('click', () => {
      if (!this.isPointerLocked) {
        this.renderer.domElement.requestPointerLock();
      }
    });
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private getTerrainHeight(x: number, z: number): number {
    const dx = x - CONFIG.MOUNTAIN_POS_X;
    const dz = z - CONFIG.MOUNTAIN_POS_Z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 100) {
      let h = Math.max(0, (1 - dist / 100) * CONFIG.MOUNTAIN_HEIGHT);
      if (dist > 40 && dist < 60) h = Math.max(h, CONFIG.CLIFF_HEIGHT);
      return h;
    }
    return 0;
  }

  private updatePlayer(dt: number) {
    if (this.player.inVehicle) {
      this.updatePlayerInVehicle(dt);
      return;
    }

    const moveDir = new THREE.Vector3();
    const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    if (this.keys.has('KeyW')) moveDir.add(forward);
    if (this.keys.has('KeyS')) moveDir.sub(forward);
    if (this.keys.has('KeyA')) moveDir.sub(right);
    if (this.keys.has('KeyD')) moveDir.add(right);

    const isSprinting = this.keys.has('ShiftLeft') && this.player.stamina > 0;
    const speed = isSprinting ? CONFIG.PLAYER_SPRINT_SPEED : CONFIG.PLAYER_WALK_SPEED;

    if (moveDir.length() > 0) {
      moveDir.normalize();
      this.player.velocity.x = moveDir.x * speed;
      this.player.velocity.z = moveDir.z * speed;

      if (isSprinting && !this.player.isClimbing && !this.player.isGliding) {
        this.player.stamina -= CONFIG.STAMINA_SPRINT_DRAIN * dt * (this.player.isWet ? CONFIG.STAMINA_RAIN_MULTIPLIER : 1);
      }
    } else {
      this.player.velocity.x *= 0.8;
      this.player.velocity.z *= 0.8;
    }

    // Jump / Glide
    if (this.keys.has('Space')) {
      if (!this.player.isClimbing && this.player.position.y <= this.getTerrainHeight(this.player.position.x, this.player.position.z) + 0.1) {
        this.player.velocity.y = CONFIG.PLAYER_JUMP_FORCE;
      } else if (this.player.hasGlider && this.player.velocity.y < 0 && !this.player.isClimbing) {
        this.player.isGliding = true;
        this.player.velocity.y = -CONFIG.PLAYER_GLIDE_FALL;
        this.player.stamina -= CONFIG.STAMINA_GLIDE_DRAIN * dt;
      }
    } else {
      this.player.isGliding = false;
    }

    // Gravity
    if (!this.player.isClimbing && !this.player.isGliding) {
      this.player.velocity.y += CONFIG.GRAVITY * dt;
    }

    // Climbing
    if (this.keys.has('Space') && this.isNearClimbable()) {
      this.player.isClimbing = true;
      this.player.velocity.y = CONFIG.PLAYER_CLIMB_SPEED;
      this.player.stamina -= CONFIG.STAMINA_CLIMB_DRAIN * dt * (this.player.isWet ? CONFIG.STAMINA_RAIN_MULTIPLIER : 1);
    } else {
      this.player.isClimbing = false;
    }

    // Stamina regen
    if (!isSprinting && !this.player.isClimbing && !this.player.isGliding) {
      this.player.stamina = Math.min(this.player.maxStamina, this.player.stamina + CONFIG.STAMINA_REGEN * dt);
    }
    this.player.stamina = Math.max(0, this.player.stamina);

    // Dodge
    if (this.player.isDodging) {
      this.player.dodgeTimer -= dt;
      this.player.position.add(this.player.dodgeDir.clone().multiplyScalar(CONFIG.DODGE_SPEED * dt));
      if (this.player.dodgeTimer <= 0) this.player.isDodging = false;
    }

    // Apply velocity
    this.player.position.add(this.player.velocity.clone().multiplyScalar(dt));

    // Terrain collision
    const terrainY = this.getTerrainHeight(this.player.position.x, this.player.position.z);
    if (this.player.position.y < terrainY) {
      // Fall damage
      if (this.player.velocity.y < -CONFIG.FALL_DAMAGE_THRESHOLD) {
        const damage = Math.floor((-this.player.velocity.y - CONFIG.FALL_DAMAGE_THRESHOLD) * CONFIG.FALL_DAMAGE_PER_M);
        this.damagePlayer(damage);
      }
      this.player.position.y = terrainY;
      this.player.velocity.y = 0;
    }

    // World bounds
    this.player.position.x = Math.max(this.worldBounds.minX, Math.min(this.worldBounds.maxX, this.player.position.x));
    this.player.position.z = Math.max(this.worldBounds.minZ, Math.min(this.worldBounds.maxZ, this.player.position.z));

    // Cooldowns
    this.player.meleeCooldown = Math.max(0, this.player.meleeCooldown - dt);

    // Update mesh
    if (this.player.mesh) {
      this.player.mesh.position.copy(this.player.position);
      this.player.mesh.position.y += CONFIG.PLAYER_HEIGHT / 2;
      // Rotate to face movement direction
      if (moveDir.length() > 0.1) {
        const targetAngle = Math.atan2(moveDir.x, moveDir.z);
        this.player.mesh.rotation.y = targetAngle;
      }
    }
  }

  private isNearClimbable(): boolean {
    // Check buildings and mountain
    for (const b of this.buildings) {
      const dx = this.player.position.x - b.position.x;
      const dz = this.player.position.z - b.position.z;
      if (Math.abs(dx) < 5 && Math.abs(dz) < 5 && this.player.position.y < b.position.y * 2) return true;
    }
    // Mountain
    const dx = this.player.position.x - CONFIG.MOUNTAIN_POS_X;
    const dz = this.player.position.z - CONFIG.MOUNTAIN_POS_Z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 80 && dist > 30 && this.player.position.y < CONFIG.CLIFF_HEIGHT) return true;
    // Towers
    for (const t of this.towers) {
      const tdx = this.player.position.x - t.pos.x;
      const tdz = this.player.position.z - t.pos.z;
      if (Math.sqrt(tdx * tdx + tdz * tdz) < 5) return true;
    }
    return false;
  }

  private updatePlayerInVehicle(dt: number) {
    const v = this.player.inVehicle!;
    const accelInput = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const turnInput = (this.keys.has('KeyA') ? 1 : 0) - (this.keys.has('KeyD') ? 1 : 0);
    const handbrake = this.keys.has('ShiftLeft');

    if (accelInput !== 0) {
      v.speed += accelInput * v.accel * dt;
    } else {
      v.speed *= 0.95;
    }
    v.speed = Math.max(-v.maxSpeed * 0.3, Math.min(v.maxSpeed, v.speed));

    if (handbrake) v.speed *= 0.9;

    v.rotation += turnInput * CONFIG.VEHICLE_TURN_SPEED * dt * (v.speed / v.maxSpeed);

    const forward = new THREE.Vector3(-Math.sin(v.rotation), 0, -Math.cos(v.rotation));
    const grip = this.isRaining ? CONFIG.VEHICLE_RAIN_GRIP_MULT : 1;
    v.position.add(forward.multiplyScalar(v.speed * dt * grip));

    // Terrain
    const terrainY = this.getTerrainHeight(v.position.x, v.position.z);
    v.position.y = terrainY;

    if (v.mesh) {
      v.mesh.position.copy(v.position);
      v.mesh.position.y += 0.8;
      v.mesh.rotation.y = v.rotation;
    }

    this.player.position.copy(v.position);

    // Exit vehicle - handled in updateInteractions
  }

  private updateVehicles(dt: number) {
    for (const v of this.vehicles) {
      if (v === this.player.inVehicle) continue;
      if (v.tethered && this.tetherTarget === v) {
        // Move toward player
        const dir = this.player.position.clone().sub(v.position).normalize();
        v.position.add(dir.multiplyScalar(CONFIG.TETHER_DRAG_SPEED * dt));
        if (v.mesh) v.mesh.position.copy(v.position);
      }
    }
  }

  private updateNPCs(dt: number) {
    for (const npc of this.npcs) {
      if (!npc.active || npc.state === 'dead') continue;

      npc.stateTimer -= dt;
      npc.attackCooldown = Math.max(0, npc.attackCooldown - dt);

      const distToPlayer = npc.position.distanceTo(this.player.position);

      // State machine
      switch (npc.state) {
        case 'wander':
          if (!npc.target || npc.stateTimer <= 0) {
            npc.target = new THREE.Vector3(
              npc.position.x + this.rng.range(-20, 20),
              0,
              npc.position.z + this.rng.range(-20, 20)
            );
            npc.stateTimer = this.rng.range(3, 8);
          }
          if (npc.target) {
            const dir = npc.target.clone().sub(npc.position).normalize();
            npc.velocity.copy(dir).multiplyScalar(CONFIG.NPC_WALK_SPEED);
            npc.position.add(dir.multiplyScalar(CONFIG.NPC_WALK_SPEED * dt));
            if (npc.position.distanceTo(npc.target) < 2) { npc.target = null; npc.velocity.set(0,0,0); }
          }
          // Detect crime
          if (this.player.heat > 0 && distToPlayer < CONFIG.NPC_DETECT_RANGE) {
            npc.state = 'flee';
            npc.stateTimer = 5;
            if (npc.type === 'pedestrian') {
              this.addHeat(CONFIG.NPC_WITNESS_HEAT_ADD);
            }
          }
          break;

        case 'flee':
          const fleeDir = npc.position.clone().sub(this.player.position).normalize();
          npc.velocity.copy(fleeDir).multiplyScalar(CONFIG.NPC_FLEE_SPEED);
          npc.position.add(fleeDir.multiplyScalar(CONFIG.NPC_FLEE_SPEED * dt));
          if (npc.stateTimer <= 0) { npc.state = 'wander'; npc.velocity.set(0,0,0); }
          break;

        case 'attack':
          if (distToPlayer < CONFIG.ENEMY_ATTACK_RANGE && npc.attackCooldown <= 0) {
            this.damagePlayer(CONFIG.ENEMY_DAMAGE);
            npc.attackCooldown = CONFIG.ENEMY_ATTACK_COOLDOWN;
          }
          if (distToPlayer < CONFIG.ENEMY_DETECT_RANGE) {
            const atkDir = this.player.position.clone().sub(npc.position).normalize();
            npc.velocity.copy(atkDir).multiplyScalar(CONFIG.ENEMY_SPEED);
            npc.position.add(atkDir.multiplyScalar(CONFIG.ENEMY_SPEED * dt));
          } else {
            npc.velocity.set(0,0,0);
          }
          if (distToPlayer > CONFIG.ENEMY_DETECT_RANGE * 1.5) npc.state = 'wander';
          break;

        case 'pursue':
          // Police pursuit
          const pursDir = this.player.position.clone().sub(npc.position).normalize();
          const pursSpeed = this.player.inVehicle ? CONFIG.HEAT_POLICE_PURSUIT_SPEED : CONFIG.PLAYER_SPRINT_SPEED;
          npc.velocity.copy(pursDir).multiplyScalar(pursSpeed);
          npc.position.add(pursDir.multiplyScalar(pursSpeed * dt));
          // Arrest
          if (distToPlayer < CONFIG.HEAT_ARREST_RANGE) {
            npc.stateTimer -= dt;
            if (npc.stateTimer <= 0) {
              this.arrestPlayer();
            }
          } else {
            npc.stateTimer = CONFIG.HEAT_ARREST_TIME;
          }
          break;
      }

      // Bandit aggro
      if (npc.type === 'bandit' && distToPlayer < CONFIG.ENEMY_DETECT_RANGE && npc.state !== 'attack' && npc.active) {
        npc.state = 'attack';
      }

      // Update mesh
      if (npc.mesh) {
        npc.mesh.position.copy(npc.position);
        npc.mesh.position.y = 1;
        // Rotate to face movement direction
        if (npc.velocity.length() > 0.1) {
          const angle = Math.atan2(npc.velocity.x, npc.velocity.z);
          npc.mesh.rotation.y = angle;
        }
      }
    }
  }

  private updateHeat(dt: number) {
    if (this.player.heat > 0) {
      // Check if any police can see player
      const policeSeePlayer = this.npcs.some(n => n.type === 'police' && n.active && n.position.distanceTo(this.player.position) < 50);
      if (!policeSeePlayer) {
        this.player.heatDecayTimer += dt;
        if (this.player.heatDecayTimer >= CONFIG.HEAT_DECAY_TIME) {
          this.player.heat = Math.max(0, this.player.heat - CONFIG.HEAT_DECAY_AMOUNT);
          this.player.heatDecayTimer = 0;
          // Remove police if heat dropped
          if (this.player.heat === 0) {
            this.npcs = this.npcs.filter(n => n.type !== 'police');
          }
        }
      } else {
        this.player.heatDecayTimer = 0;
      }

      // Spawn police based on heat
      const policeCount = this.npcs.filter(n => n.type === 'police' && n.active).length;
      const targetPolice = this.getHeatPoliceCount();
      if (policeCount < targetPolice && this.rng.chance(0.02)) {
        this.spawnPolice();
      }
    }
  }

  private getHeatPoliceCount(): number {
    if (this.player.heat >= CONFIG.HEAT_POLICE_SPAWN_4) return CONFIG.HEAT_POLICE_COUNT_4;
    if (this.player.heat >= CONFIG.HEAT_POLICE_SPAWN_3) return CONFIG.HEAT_POLICE_COUNT_3;
    if (this.player.heat >= CONFIG.HEAT_POLICE_SPAWN_2) return CONFIG.HEAT_POLICE_COUNT_2;
    if (this.player.heat >= CONFIG.HEAT_POLICE_SPAWN_1) return CONFIG.HEAT_POLICE_COUNT_1;
    return 0;
  }

  private spawnPolice() {
    const angle = this.rng.next() * Math.PI * 2;
    const dist = 40;
    const npc = this.createNPC('police');
    npc.position.set(
      this.player.position.x + Math.cos(angle) * dist,
      0,
      this.player.position.z + Math.sin(angle) * dist
    );
    npc.state = 'pursue';
    npc.stateTimer = CONFIG.HEAT_ARREST_TIME;
    this.npcs.push(npc);
  }

  private addHeat(amount: number) {
    this.player.heat = Math.min(CONFIG.HEAT_MAX, this.player.heat + amount);
    this.player.heatDecayTimer = 0;
  }

  private damagePlayer(amount: number) {
    if (this.player.isDodging && this.player.dodgeTimer > CONFIG.DODGE_DURATION - CONFIG.DODGE_IFRAMES) return;
    this.player.health -= amount;
    if (this.player.health <= 0) {
      this.playerDeath();
    }
  }

  private playerDeath() {
    this.player.health = this.player.maxHealth;
    this.player.cash = Math.floor(this.player.cash * (1 - CONFIG.HEAT_CASH_PENALTY_PCT));
    this.player.heat = 0;
    this.player.position.set(0, 0, 0);
    if (this.player.inVehicle) this.player.inVehicle = null;
  }

  private arrestPlayer() {
    this.player.health = this.player.maxHealth;
    this.player.cash = Math.floor(this.player.cash * (1 - CONFIG.HEAT_CASH_PENALTY_PCT));
    this.player.heat = 0;
    this.player.position.set(0, 0, 0);
    if (this.player.inVehicle) this.player.inVehicle = null;
    this.npcs = this.npcs.filter(n => n.type !== 'police');
  }

  private updateCombat(dt: number) {
    // Melee attack
    if (this.mouseDown.left && this.player.meleeCooldown <= 0) {
      this.player.meleeCooldown = CONFIG.MELEE_COOLDOWN;
      // Find target in range
      const target = this.player.lockOnTarget || this.findNearestEnemy();
      if (target && target.position.distanceTo(this.player.position) < CONFIG.MELEE_RANGE) {
        (target as NPC).health -= CONFIG.MELEE_DAMAGE;
        if ((target as NPC).health <= 0) {
          (target as NPC).state = 'dead';
          (target as NPC).active = false;
          if ((target as NPC).type === 'bandit') this.addHeat(CONFIG.HEAT_MURDER);
        }
      }
    }

    // Dodge
    if (this.mouseDown.right && !this.player.isDodging) {
      this.player.isDodging = true;
      this.player.dodgeTimer = CONFIG.DODGE_DURATION;
      const forward = new THREE.Vector3(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
      this.player.dodgeDir = forward;
    }

    // Lock-on
    if (this.keys.has('KeyQ')) {
      this.player.lockOnTarget = this.findNearestEnemy();
    } else {
      this.player.lockOnTarget = null;
    }
  }

  private findNearestEnemy(): Entity | null {
    let nearest: Entity | null = null;
    let minDist: number = CONFIG.LOCKON_RANGE;
    for (const npc of this.npcs) {
      if (npc.type === 'bandit' && npc.active) {
        const dist = npc.position.distanceTo(this.player.position);
        if (dist < minDist) {
          minDist = dist;
          nearest = npc;
        }
      }
    }
    return nearest;
  }

  private updateTether(dt: number) {
    if (this.keys.has('KeyF') && this.player.hasTether) {
      // Find metal object in range
      if (!this.tetherTarget) {
        for (const v of this.vehicles) {
          if (v.isMetal && v.position.distanceTo(this.player.position) < this.player.tetherRange) {
            this.tetherTarget = v;
            v.tethered = true;
            break;
          }
        }
      }
      // Launch
      if (this.tetherTarget && this.mouseDown.left) {
        const dir = new THREE.Vector3(-Math.sin(this.cameraYaw), 0.3, -Math.cos(this.cameraYaw));
        this.tetherTarget.position.add(dir.multiplyScalar(CONFIG.TETHER_LAUNCH_FORCE * dt));
        // Damage if hits something
        if (this.tetherTarget.speed > 10) {
          for (const npc of this.npcs) {
            if (npc.position.distanceTo(this.tetherTarget.position) < 3) {
              this.damagePlayer(CONFIG.ENEMY_DAMAGE);
            }
          }
        }
      }
      // Update tether line
      if (this.tetherLine && this.tetherTarget) {
        const positions = this.tetherLine.geometry.attributes.position as THREE.BufferAttribute;
        positions.setXYZ(0, this.player.position.x, this.player.position.y + 1, this.player.position.z);
        positions.setXYZ(1, this.tetherTarget.position.x, this.tetherTarget.position.y + 1, this.tetherTarget.position.z);
        positions.needsUpdate = true;
        this.tetherLine.visible = true;
      }
    } else {
      if (this.tetherTarget) {
        this.tetherTarget.tethered = false;
        this.tetherTarget = null;
      }
      if (this.tetherLine) this.tetherLine.visible = false;
    }
  }

  private updateEnvironment(dt: number) {
    // Day/night cycle
    this.dayTime += dt / CONFIG.DAY_LENGTH;
    if (this.dayTime > 1) this.dayTime = 0;

    const isNight = this.dayTime > CONFIG.NIGHT_START || this.dayTime < CONFIG.NIGHT_END;
    const lightIntensity = isNight ? 0.2 : 1;
    if (this.sunLight) this.sunLight.intensity = lightIntensity;
    if (this.ambientLight) this.ambientLight.intensity = isNight ? 0.3 : 0.5;

    const skyColor = isNight ? 0x111133 : 0x87ceeb;
    this.scene.background = new THREE.Color(skyColor);
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.set(skyColor);

    // Rain
    this.rainTimer -= dt;
    if (this.rainTimer <= 0) {
      this.isRaining = !this.isRaining;
      this.rainTimer = this.rng.range(60, 180);
    }
    this.player.isWet = this.isRaining;
  }

  private updateMissions(dt: number) {
    for (const m of this.missions) {
      if (!m.active || m.completed || m.failed) continue;

      // Timer
      if (m.steps[m.currentStep]?.timeLimit) {
        m.timer += dt;
        if (m.timer >= m.steps[m.currentStep].timeLimit!) {
          m.failed = true;
          continue;
        }
      }

      const step = m.steps[m.currentStep];
      if (!step) {
        m.completed = true;
        this.player.cash += m.reward.cash;
        this.saveGame();
        continue;
      }

      // Check step completion
      if (step.type === 'talk') {
        const giverDist = this.player.position.distanceTo(m.giverPos);
        if (giverDist < 3 && this.keys.has('KeyE')) {
          m.currentStep++;
        }
      } else if (step.type === 'goto' || step.type === 'drive_to') {
        if (step.targetPos && this.player.position.distanceTo(step.targetPos) < (step.radius || 5)) {
          m.currentStep++;
        }
      } else if (step.type === 'lose_heat') {
        if (this.player.heat === 0) m.currentStep++;
      } else if (step.type === 'tether_object') {
        if (this.tetherTarget && step.targetPos && this.tetherTarget.position.distanceTo(step.targetPos) < 5) {
          m.currentStep++;
        }
      }
    }
  }

  private updateInteractions() {
    // Vehicle enter/exit
    if (this.keys.has('KeyE')) {
      if (this.player.inVehicle) {
        // Exit vehicle
        const v = this.player.inVehicle;
        this.player.inVehicle = null;
        this.player.position.x = v.position.x + 3;
        this.player.position.y = v.position.y;
        this.player.position.z = v.position.z;
        this.player.velocity.set(0, 0, 0);
        // Show player mesh again
        if (this.player.mesh) this.player.mesh.visible = true;
        this.keys.delete('KeyE'); // Prevent re-trigger
      } else {
        for (const v of this.vehicles) {
          if (v.position.distanceTo(this.player.position) < CONFIG.VEHICLE_ENTER_RANGE) {
            this.player.inVehicle = v;
            // Hide player mesh when in vehicle
            if (this.player.mesh) this.player.mesh.visible = false;
            if (v.occupied && v.driverNPC) {
              v.driverNPC.state = 'flee';
              v.driverNPC.stateTimer = 5;
              v.occupied = false;
              this.addHeat(CONFIG.HEAT_CARJACK);
            }
            this.keys.delete('KeyE');
            break;
          }
        }
      }
    }

    // Shrine interaction
    if (this.keys.has('KeyE')) {
      for (const s of this.shrines) {
        if (!s.solved && this.player.position.distanceTo(s.position) < 5) {
          s.solved = true;
          if (s.puzzleType === 'glider') {
            this.player.hasGlider = true;
            this.player.abilities.push('glider');
          } else if (s.puzzleType === 'tether') {
            this.player.hasTether = true;
            this.player.abilities.push('tether');
          }
        }
      }
    }

    // Tower interaction
    if (this.keys.has('KeyE')) {
      for (const t of this.towers) {
        if (!t.revealed && this.player.position.distanceTo(t.pos) < 5) {
          t.revealed = true;
        }
      }
    }

    // Shop interaction
    if (this.keys.has('KeyE')) {
      const shopPos = new THREE.Vector3(CONFIG.SHOP_POS_X, 0, CONFIG.SHOP_POS_Z);
      if (this.player.position.distanceTo(shopPos) < 5) {
        for (const item of this.shops) {
          if (!item.purchased && this.player.cash >= item.cost) {
            this.player.cash -= item.cost;
            item.purchased = true;
            if (item.effect === 'health') {
              this.player.maxHealth += item.value;
              this.player.health += item.value;
            } else if (item.effect === 'stamina') {
              this.player.maxStamina += item.value;
            } else if (item.effect === 'tether_range') {
              this.player.tetherRange += item.value;
            }
            break;
          }
        }
      }
    }

    // Mission start
    if (this.keys.has('KeyE')) {
      for (const m of this.missions) {
        if (!m.active && !m.completed && !m.failed && this.player.position.distanceTo(m.giverPos) < 3) {
          const meetsReqs = m.requires.abilities.every(a => this.player.abilities.includes(a)) && this.player.heat <= m.requires.maxHeat;
          if (meetsReqs) {
            m.active = true;
            // M2 starts player at heat 3
            if (m.id === 'm2_heat_escape') {
              this.player.heat = 3;
              this.player.heatDecayTimer = 0;
            }
            this.keys.delete('KeyE');
          }
        }
      }
    }
  }

  private updateCamera() {
    // Mouse look
    this.cameraYaw -= this.mouseDelta.x * CONFIG.CAM_SENSITIVITY;
    this.cameraPitch -= this.mouseDelta.y * CONFIG.CAM_SENSITIVITY;
    this.cameraPitch = Math.max(CONFIG.CAM_MIN_PITCH, Math.min(CONFIG.CAM_MAX_PITCH, this.cameraPitch));
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;

    // Third person camera
    const offset = new THREE.Vector3(
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch) * CONFIG.CAM_DISTANCE,
      Math.sin(this.cameraPitch) * CONFIG.CAM_DISTANCE + CONFIG.CAM_HEIGHT,
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch) * CONFIG.CAM_DISTANCE
    );
    const targetPos = this.player.position.clone().add(offset);
    this.camera.position.lerp(targetPos, 0.1);
    this.camera.lookAt(this.player.position.x, this.player.position.y + 1.5, this.player.position.z);
  }

  private updateSave(dt: number) {
    this.saveTimer += dt;
    if (this.saveTimer >= CONFIG.SAVE_INTERVAL) {
      this.saveGame();
      this.saveTimer = 0;
    }
  }

  private saveGame() {
    try {
      const data = {
        seed: this.seed,
        player: {
          health: this.player.health,
          maxHealth: this.player.maxHealth,
          stamina: this.player.stamina,
          maxStamina: this.player.maxStamina,
          cash: this.player.cash,
          position: { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
          abilities: this.player.abilities,
          hasGlider: this.player.hasGlider,
          hasTether: this.player.hasTether,
          tetherRange: this.player.tetherRange,
        },
        shrines: this.shrines.map(s => ({ id: s.id, solved: s.solved })),
        towers: this.towers.map(t => ({ revealed: t.revealed })),
        shops: this.shops.map(s => ({ id: s.id, purchased: s.purchased })),
        missions: this.missions.map(m => ({ id: m.id, active: m.active, completed: m.completed, failed: m.failed, currentStep: m.currentStep })),
      };
      localStorage.setItem('shattered_meridian_save', JSON.stringify(data));
    } catch (e) {
      // Storage blocked, continue without saving
    }
  }

  private loadGame() {
    try {
      const raw = localStorage.getItem('shattered_meridian_save');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.player) {
        this.player.health = data.player.health;
        this.player.maxHealth = data.player.maxHealth;
        this.player.stamina = data.player.stamina;
        this.player.maxStamina = data.player.maxStamina;
        this.player.cash = data.player.cash;
        this.player.position.set(data.player.position.x, data.player.position.y, data.player.position.z);
        this.player.abilities = data.player.abilities || [];
        this.player.hasGlider = data.player.hasGlider || false;
        this.player.hasTether = data.player.hasTether || false;
        this.player.tetherRange = data.player.tetherRange || CONFIG.TETHER_RANGE;
      }
      if (data.shrines) {
        for (const s of data.shrines) {
          const shrine = this.shrines.find(sh => sh.id === s.id);
          if (shrine) shrine.solved = s.solved;
        }
      }
      if (data.towers) {
        for (let i = 0; i < data.towers.length; i++) {
          if (this.towers[i]) this.towers[i].revealed = data.towers[i].revealed;
        }
      }
      if (data.shops) {
        for (const s of data.shops) {
          const shop = this.shops.find(sh => sh.id === s.id);
          if (shop) shop.purchased = s.purchased;
        }
      }
      if (data.missions) {
        for (const m of data.missions) {
          const mission = this.missions.find(mi => mi.id === m.id);
          if (mission) {
            mission.active = m.active;
            mission.completed = m.completed;
            mission.failed = m.failed;
            mission.currentStep = m.currentStep;
          }
        }
      }
    } catch (e) {
      // Storage blocked or corrupted, start fresh
    }
  }

  private uiInitialized = false;

  private initUI() {
    if (this.uiInitialized) return;
    this.uiInitialized = true;

    // Create persistent UI container
    const ui = document.createElement('div');
    ui.id = 'game-ui';
    ui.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;font-family:monospace;color:white;text-shadow:1px 1px 2px black;z-index:100;';
    document.body.appendChild(ui);

    // Create persistent pause overlay
    const pauseOverlay = document.createElement('div');
    pauseOverlay.id = 'pause-overlay';
    pauseOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:none;flex-direction:column;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;z-index:200;';
    pauseOverlay.innerHTML = `
      <h1 style="font-size:48px;margin-bottom:20px;color:white;">SHATTERED MERIDIAN</h1>
      <p style="font-size:18px;margin-bottom:10px;color:white;">Click anywhere to play</p>
      <div style="font-size:14px;text-align:left;line-height:1.8;color:#ccc;">
        <p>WASD - Move/Drive | Mouse - Camera</p>
        <p>Shift - Sprint/Handbrake | Space - Jump/Glide</p>
        <p>E - Interact/Enter Vehicle | F - Tether/Debug</p>
        <p>Left Click - Attack/Launch | Right Click - Dodge</p>
        <p>Q - Lock-on Target</p>
        <p style="margin-top:10px;color:#888;">Seed: ${this.seed}</p>
      </div>
    `;
    pauseOverlay.addEventListener('click', (e) => {
      e.stopPropagation();
      this.renderer.domElement.requestPointerLock();
    });
    document.body.appendChild(pauseOverlay);
  }

  private renderUI() {
    this.initUI();

    const ui = document.getElementById('game-ui');
    if (!ui) return;

    // Health (hearts)
    let heartsHTML = '<div id="hud-hearts" style="position:absolute;top:10px;left:10px;font-size:24px;">';
    for (let i = 0; i < this.player.maxHealth; i++) {
      heartsHTML += i < this.player.health ? '❤️' : '🖤';
    }
    heartsHTML += '</div>';

    // Stamina bar
    const staminaPct = (this.player.stamina / this.player.maxStamina) * 100;
    const staminaHTML = `<div style="position:absolute;top:45px;left:10px;width:200px;height:15px;background:rgba(0,0,0,0.5);border:1px solid white;"><div style="width:${staminaPct}%;height:100%;background:${staminaPct < 30 ? 'red' : 'cyan'};transition:width 0.1s;"></div></div>`;

    // Heat
    const heatHTML = `<div style="position:absolute;top:70px;left:10px;font-size:18px;">⭐${'★'.repeat(this.player.heat)}${'☆'.repeat(CONFIG.HEAT_MAX - this.player.heat)} ${this.player.heatDecayTimer > 0 ? `(${Math.ceil(CONFIG.HEAT_DECAY_TIME - this.player.heatDecayTimer)}s)` : ''}</div>`;

    // Cash
    const cashHTML = `<div style="position:absolute;top:95px;left:10px;font-size:18px;">💰 $${this.player.cash}</div>`;

    // Abilities
    const abilitiesHTML = `<div style="position:absolute;top:120px;left:10px;font-size:14px;">${this.player.hasGlider ? '🪂 Glider' : ''} ${this.player.hasTether ? '🔗 Tether' : ''}</div>`;

    // Minimap
    const minimapHTML = `<div style="position:absolute;top:10px;right:10px;width:150px;height:150px;background:rgba(0,0,0,0.7);border:2px solid white;border-radius:4px;"><canvas id="minimap" width="150" height="150"></canvas></div>`;

    // Mission HUD
    let missionHTML = '';
    const activeMission = this.missions.find(m => m.active && !m.completed && !m.failed);
    if (activeMission) {
      const step = activeMission.steps[activeMission.currentStep];
      missionHTML = `<div style="position:absolute;top:170px;left:10px;font-size:16px;background:rgba(0,0,0,0.7);padding:5px 10px;border-radius:4px;">📋 ${activeMission.title}<br>→ ${step?.type || 'Complete!'}${activeMission.timer > 0 ? ` (${Math.ceil((step?.timeLimit || 0) - activeMission.timer)}s)` : ''}</div>`;
    }

    // Debug overlay
    let debugHTML = '';
    if (this.showDebug) {
      debugHTML = `<div style="position:absolute;bottom:10px;left:10px;font-size:12px;background:rgba(0,0,0,0.8);padding:10px;border-radius:4px;">
        <p>FPS: ${this.fps}</p>
        <p>Entities: ${this.npcs.filter(n => n.active).length} NPCs, ${this.vehicles.length} vehicles</p>
        <p>Heat: ${this.player.heat} (decay: ${this.player.heatDecayTimer.toFixed(1)}s)</p>
        <p>Stamina: ${this.player.stamina.toFixed(0)}/${this.player.maxStamina}</p>
        <p>Position: ${this.player.position.x.toFixed(1)}, ${this.player.position.y.toFixed(1)}, ${this.player.position.z.toFixed(1)}</p>
        <p>Mission: ${activeMission?.id || 'none'} step ${activeMission?.currentStep || 0}</p>
        <p>Seed: ${this.seed}</p>
        <p>Rain: ${this.isRaining} | Day: ${(this.dayTime * 24).toFixed(1)}h</p>
      </div>`;
    }

    ui.innerHTML = heartsHTML + staminaHTML + heatHTML + cashHTML + abilitiesHTML + minimapHTML + missionHTML + debugHTML;

    // Toggle pause overlay visibility
    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.style.display = this.showPause ? 'flex' : 'none';
    }

    // Draw minimap
    this.drawMinimap();
  }

  private drawMinimap() {
    const canvas = document.getElementById('minimap') as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 150, 150);

    const scale = 150 / CONFIG.WORLD_SIZE_X;
    const offsetX = 75;
    const offsetZ = 75;

    // Fog of war
    for (const t of this.towers) {
      if (t.revealed) {
        ctx.fillStyle = 'rgba(100,100,100,0.3)';
        ctx.beginPath();
        ctx.arc(offsetX + t.pos.x * scale, offsetZ + t.pos.z * scale, CONFIG.TOWER_REVEAL_RADIUS * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.arc(offsetX + this.player.position.x * scale, offsetZ + this.player.position.z * scale, 3, 0, Math.PI * 2);
    ctx.fill();

    // Mission givers
    for (const m of this.missions) {
      if (!m.completed && !m.failed) {
        ctx.fillStyle = m.active ? '#ffff00' : '#ff8800';
        ctx.beginPath();
        ctx.arc(offsetX + m.giverPos.x * scale, offsetZ + m.giverPos.z * scale, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Shop
    ctx.fillStyle = '#00ffff';
    ctx.fillRect(offsetX + CONFIG.SHOP_POS_X * scale - 2, offsetZ + CONFIG.SHOP_POS_Z * scale - 2, 4, 4);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());

    // FPS counter
    this.frameCount++;
    this.fpsTimer += this.clock.getDelta();
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    if (this.showPause) {
      this.renderer.render(this.scene, this.camera);
      this.renderUI();
      return;
    }

    const dt = Math.min(this.clock.getDelta(), CONFIG.MAX_DT_CLAMP);

    // Update systems
    this.updatePlayer(dt);
    this.updateVehicles(dt);
    this.updateNPCs(dt);
    this.updateHeat(dt);
    this.updateCombat(dt);
    this.updateTether(dt);
    this.updateEnvironment(dt);
    this.updateMissions(dt);
    this.updateInteractions();
    this.updateCamera();
    this.updateSave(dt);

    // Render
    this.renderer.render(this.scene, this.camera);
    this.renderUI();
  }

  public destroy() {
    this.renderer.dispose();
    const ui = document.getElementById('game-ui');
    if (ui) ui.remove();
  }
}
