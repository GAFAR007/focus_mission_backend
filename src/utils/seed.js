/**
 * WHAT:
 * seed.js resets the development database and inserts a stable Focus Mission
 * dataset for local testing.
 * WHY:
 * Phase 2 learning enforcement needs real subject, unit, criterion, learning
 * content, block, and student progress records to verify the progression flow.
 * HOW:
 * Clear the development collections, create the baseline users and timetable,
 * then create an English sample criterion path in the initial learning state.
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");

const connectDB = require("../config/db");
const AuditLog = require("../models/AuditLog");
const Block = require("../models/Block");
const Criterion = require("../models/Criterion");
const LearningContent = require("../models/LearningContent");
const Mission = require("../models/Mission");
const Notification = require("../models/Notification");
const Question = require("../models/Question");
const SessionLog = require("../models/SessionLog");
const StudentProgress = require("../models/StudentProgress");
const Subject = require("../models/Subject");
const Target = require("../models/Target");
const Timetable = require("../models/Timetable");
const Unit = require("../models/Unit");
const User = require("../models/User");

async function seed() {
  await connectDB();

  if (!process.env.MONGODB_URI) {
    throw new Error(
      "Set MONGODB_URI before running the seed script.",
    );
  }

  await Promise.all([
    AuditLog.deleteMany({}),
    Block.deleteMany({}),
    Criterion.deleteMany({}),
    LearningContent.deleteMany({}),
    Mission.deleteMany({}),
    Notification.deleteMany({}),
    Question.deleteMany({}),
    SessionLog.deleteMany({}),
    StudentProgress.deleteMany({}),
    Subject.deleteMany({}),
    Target.deleteMany({}),
    Timetable.deleteMany({}),
    Unit.deleteMany({}),
    User.deleteMany({}),
  ]);

  const studentSeedPassword = "Password123!";
  const staffSeedPassword = "flexiblelearning123!";
  const studentPasswordHash = await bcrypt.hash(studentSeedPassword, 10);
  const staffPasswordHash = await bcrypt.hash(staffSeedPassword, 10);

  const [
    student,
    johnStudent,
    sportTeacher,
    ictTeacher,
    businessTeacher,
    scienceTeacher,
    englishBotTeacher,
    mathsBotTeacher,
    mentor,
  ] = await User.create([
    {
      name: "Mohammed",
      email: "student@focusmission.app",
      passwordHash: studentPasswordHash,
      role: "student",
      avatarSeed: "Finn",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/png?seed=Finn&size=128&hair=short15&earringsProbability=0&glassesProbability=0",
      xp: 0,
      streak: 0,
    },
    {
      name: "John",
      email: "john@focusmission.app",
      passwordHash: studentPasswordHash,
      role: "student",
      avatarSeed: "John",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/png?seed=John&size=128&hair=short16&earringsProbability=0&glassesProbability=0",
      xp: 0,
      streak: 0,
    },
    {
      name: "Mikolaj Radomski",
      email:
        "sport.teacher@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "Sport",
      avatarSeed: "Mikolaj Radomski",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Mikolaj%20Radomski",
    },
    {
      name: "Mashrur Hossain",
      email:
        "ict.teacher@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "ICT",
      avatarSeed: "Mashrur Hossain",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Mashrur%20Hossain",
    },
    {
      name: "Tehreem Ali",
      email:
        "business.teacher@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "Business",
      avatarSeed: "Tehreem Ali",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Tehreem%20Ali",
    },
    {
      name: "Ndumisa Nkomazana",
      email:
        "science.teacher@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "Science",
      avatarSeed: "Ndumisa Nkomazana",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Ndumisa%20Nkomazana",
    },
    {
      name: "English Bot Teacher",
      email:
        "english.bot@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "English",
      isPlaceholder: true,
      avatarSeed: "English Bot Teacher",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=English%20Bot%20Teacher",
    },
    {
      name: "Maths Bot Teacher",
      email:
        "maths.bot@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "teacher",
      subjectSpecialty: "Mathematics",
      isPlaceholder: true,
      avatarSeed: "Maths Bot Teacher",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Maths%20Bot%20Teacher",
    },
    {
      name: "Gafar Temitayo Razak",
      email: "mentor@focusmission.app",
      passwordHash: staffPasswordHash,
      role: "mentor",
      avatarSeed:
        "Gafar Temitayo Razak",
      avatar:
        "https://api.dicebear.com/9.x/adventurer/svg?seed=Gafar%20Temitayo%20Razak",
    },
  ]);

  const [
    sport,
    ict,
    business,
    science,
    english,
    mathematics,
  ] = await Subject.create([
    {
      name: "Sport",
      icon: "sports_soccer",
      color: "#F6C764",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
    {
      name: "ICT",
      icon: "computer",
      color: "#82D7C6",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
    {
      name: "Business",
      icon: "briefcase",
      color: "#8EC5FF",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
    {
      name: "Science",
      icon: "science",
      color: "#B7A3FF",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
    {
      name: "English",
      icon: "menu_book",
      color: "#FFBFA8",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
    {
      name: "Mathematics",
      icon: "calculate",
      color: "#8AD2A1",
      difficultyDefaults: [
        "easy",
        "medium",
      ],
    },
  ]);

  const englishNarrativeUnit = await Unit.create({
    subjectId: english._id,
    title: "Narrative Writing",
    description:
      "Build GCSE narrative writing confidence through structured character work.",
    baseOrder: 0,
    isActive: true,
  });

  const characterisationCriterion = await Criterion.create({
    subjectId: english._id,
    unitId: englishNarrativeUnit._id,
    title: "Understand characterisation in narrative writing",
    description:
      "Learn how writers show what a character looks like, feels, and behaves before building an essay response.",
    baseOrder: 0,
    requiredWordCount: 40,
    learningPassRate: 75,
    isActive: true,
  });

  await LearningContent.create({
    subjectId: english._id,
    unitId: englishNarrativeUnit._id,
    criterionId: characterisationCriterion._id,
    title: "Characterisation basics",
    summary:
      "Short GCSE-ready teaching content introducing what characterisation is and how writers use it.",
    sections: [
      {
        heading: "What characterisation means",
        body:
          "Characterisation is the way a writer creates and develops a character in a story. It helps the reader understand what the character looks like, how they behave, what they think and feel, and their personality.",
        baseOrder: 0,
      },
      {
        heading: "Two main types",
        body:
          "Writers use two main types of characterisation: direct and indirect. Direct characterisation tells the reader something clearly. Indirect characterisation shows it through actions, speech, thoughts, and reactions.",
        baseOrder: 1,
      },
      {
        heading: "Why it matters",
        body:
          "Strong characterisation helps the reader picture the character and understand their choices. This makes a narrative more believable and more interesting to read.",
        baseOrder: 2,
      },
    ],
    status: "approved",
    source: "teacher",
    createdBy: englishBotTeacher._id,
    approvedBy: englishBotTeacher._id,
    approvedAt: new Date(),
  });

  await Block.create([
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "multipleChoice",
      phase: "learningCheck",
      prompt: "What is characterisation?",
      options: [
        "The way a writer creates and develops a character in a story",
        "The final paragraph of a story",
        "The title of a story",
        "The setting of a story",
      ],
      correctIndex: 0,
      generatedSentence: "",
      baseOrder: 0,
      isRequired: true,
    },
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "multipleChoice",
      phase: "learningCheck",
      prompt: "What are the two main types of characterisation?",
      options: [
        "Direct and indirect",
        "Fast and slow",
        "Old and new",
        "Big and small",
      ],
      correctIndex: 0,
      generatedSentence: "",
      baseOrder: 1,
      isRequired: true,
    },
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "multipleChoice",
      phase: "learningCheck",
      prompt: "Which answer describes indirect characterisation?",
      options: [
        "Showing character through actions, speech, thoughts, and reactions",
        "Listing page numbers",
        "Naming the story",
        "Changing the font size",
      ],
      correctIndex: 0,
      generatedSentence: "",
      baseOrder: 2,
      isRequired: true,
    },
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "sentenceBuilder",
      phase: "essayBuilder",
      prompt: "Write one sentence explaining what characterisation helps the reader understand.",
      options: [],
      correctIndex: -1,
      generatedSentence:
        "Characterisation helps the reader understand what a character is like and why they act in certain ways.",
      baseOrder: 0,
      isRequired: true,
    },
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "evidenceBuilder",
      phase: "essayBuilder",
      prompt: "Write one sentence about how direct characterisation works.",
      options: [],
      correctIndex: -1,
      generatedSentence:
        "Direct characterisation tells the reader important details about a character clearly.",
      baseOrder: 1,
      isRequired: true,
    },
    {
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      type: "explanationBuilder",
      phase: "essayBuilder",
      prompt: "Write one sentence about how indirect characterisation works.",
      options: [],
      correctIndex: -1,
      generatedSentence:
        "Indirect characterisation shows the character through actions, thoughts, and speech instead of telling the reader directly.",
      baseOrder: 2,
      isRequired: true,
    },
  ]);

  await Question.create([
    {
      subjectId: sport._id,
      question:
        "Which activity is a team sport?",
      options: [
        "Football",
        "Reading",
        "Painting",
        "Typing",
      ],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["movement"],
    },
    {
      subjectId: ict._id,
      question:
        "Which device is best for typing a document?",
      options: [
        "Keyboard",
        "Ruler",
        "Cup",
        "Pencil case",
      ],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["devices"],
    },
    {
      subjectId: business._id,
      question:
        "What do people usually use to buy an item in a shop?",
      options: [
        "Money",
        "A whistle",
        "A ruler",
        "A paintbrush",
      ],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["money"],
    },
    {
      subjectId: science._id,
      question:
        "Which of these is used in a science experiment?",
      options: [
        "Beaker",
        "Pillow",
        "Remote control",
        "Shoelace",
      ],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["lab"],
    },
    {
      subjectId: english._id,
      question:
        "Which sentence starts with a capital letter?",
      options: [
        "The dog is running.",
        "the dog is running.",
        "the Dog is running.",
        "the dog Is running.",
      ],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["language"],
    },
    {
      subjectId: mathematics._id,
      question: "What is 2 + 3?",
      options: ["5", "4", "6", "7"],
      correctIndex: 0,
      difficulty: "easy",
      tags: ["numbers"],
    },
  ]);

  await Timetable.create([
    {
      studentId: student._id,
      day: "Monday",
      morningSubject: sport._id,
      afternoonSubject: ict._id,
      room: "Room 2",
      morningTeacherId:
        sportTeacher._id,
      afternoonTeacherId:
        ictTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: student._id,
      day: "Tuesday",
      morningSubject: business._id,
      afternoonSubject: science._id,
      room: "Room 1",
      morningTeacherId:
        businessTeacher._id,
      afternoonTeacherId:
        scienceTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: student._id,
      day: "Wednesday",
      morningSubject: ict._id,
      afternoonSubject: sport._id,
      room: "Room 3",
      morningTeacherId: ictTeacher._id,
      afternoonTeacherId:
        sportTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: student._id,
      day: "Thursday",
      morningSubject: science._id,
      afternoonSubject: business._id,
      room: "Room 4",
      morningTeacherId:
        scienceTeacher._id,
      afternoonTeacherId:
        businessTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: student._id,
      day: "Friday",
      morningSubject: english._id,
      afternoonSubject: mathematics._id,
      room: "Room 3",
      morningTeacherId:
        englishBotTeacher._id,
      afternoonTeacherId:
        mathsBotTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: johnStudent._id,
      day: "Monday",
      morningSubject: sport._id,
      afternoonSubject: ict._id,
      room: "Room 2",
      morningTeacherId:
        sportTeacher._id,
      afternoonTeacherId:
        ictTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: johnStudent._id,
      day: "Tuesday",
      morningSubject: business._id,
      afternoonSubject: science._id,
      room: "Room 1",
      morningTeacherId:
        businessTeacher._id,
      afternoonTeacherId:
        scienceTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: johnStudent._id,
      day: "Wednesday",
      morningSubject: ict._id,
      afternoonSubject: sport._id,
      room: "Room 3",
      morningTeacherId: ictTeacher._id,
      afternoonTeacherId:
        sportTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: johnStudent._id,
      day: "Thursday",
      morningSubject: science._id,
      afternoonSubject: business._id,
      room: "Room 4",
      morningTeacherId:
        scienceTeacher._id,
      afternoonTeacherId:
        businessTeacher._id,
      mentorId: mentor._id,
    },
    {
      studentId: johnStudent._id,
      day: "Friday",
      morningSubject: english._id,
      afternoonSubject: mathematics._id,
      room: "Room 3",
      morningTeacherId:
        englishBotTeacher._id,
      afternoonTeacherId:
        mathsBotTeacher._id,
      mentorId: mentor._id,
    },
  ]);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDateKey = [
    tomorrow.getFullYear(),
    String(tomorrow.getMonth() + 1).padStart(2, "0"),
    String(tomorrow.getDate()).padStart(2, "0"),
  ].join("-");
  const tomorrowWeekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  }).format(tomorrow);

  await Mission.create([
    {
      studentId: johnStudent._id,
      subjectId: sport._id,
      sessionType: "morning",
      title: "John Daily Sport Mission",
      teacherNote:
        "Daily mission for John. Keep momentum high with clear, short questions.",
      source: "bank",
      status: "published",
      publishedAt: new Date(),
      availableOnDate: tomorrowDateKey,
      availableOnDay: tomorrowWeekday,
      xpReward: 20,
      latestScoreCorrect: 0,
      latestScoreTotal: 0,
      latestScorePercent: 0,
      latestXpEarned: 0,
      questions: [
        {
          learningText:
            "Fast-twitch muscles help with quick, explosive movements such as sprint starts.",
          prompt:
            "Based on what you just learned, which muscles are mainly used in explosive actions?",
          options: [
            "Fast-twitch muscles",
            "Slow-twitch muscles only",
            "Finger muscles only",
            "Jaw muscles only",
          ],
          correctIndex: 0,
          explanation:
            "Fast-twitch muscles are linked to quick and powerful movement.",
        },
        {
          learningText:
            "Quadriceps extend the knee, while hamstrings help bend the knee.",
          prompt:
            "Based on what you just learned, which muscle group helps flex the knee?",
          options: [
            "Hamstrings",
            "Quadriceps",
            "Deltoids",
            "Triceps",
          ],
          correctIndex: 0,
          explanation:
            "Hamstrings help with knee flexion (bending the knee).",
        },
        {
          learningText:
            "Joints are points where two bones meet and allow movement.",
          prompt:
            "Based on what you just learned, what is a joint?",
          options: [
            "A place where two bones meet",
            "A type of muscle fiber",
            "A type of shoe",
            "A warm-up drill",
          ],
          correctIndex: 0,
          explanation: "Joints connect bones and support movement.",
        },
        {
          learningText:
            "Dynamic warm-ups raise heart rate and prepare muscles for activity.",
          prompt:
            "Based on what you just learned, why do athletes warm up?",
          options: [
            "To prepare the body for movement",
            "To reduce hydration",
            "To skip training",
            "To avoid all movement",
          ],
          correctIndex: 0,
          explanation: "Warm-ups prepare muscles and joints for activity.",
        },
        {
          learningText:
            "A sprint uses anaerobic energy for short, high-intensity effort.",
          prompt:
            "Based on what you just learned, sprinting mainly uses which energy type?",
          options: [
            "Anaerobic energy",
            "Only digestive energy",
            "No energy",
            "Sleep energy",
          ],
          correctIndex: 0,
          explanation:
            "Short, intense efforts are mainly anaerobic.",
        },
        {
          learningText:
            "Balance supports coordination and reduces risk of falling during movement.",
          prompt:
            "Based on what you just learned, why is balance important in sport?",
          options: [
            "It improves control and safety",
            "It makes shoes heavier",
            "It removes all fatigue",
            "It replaces practice",
          ],
          correctIndex: 0,
          explanation:
            "Balance helps body control and safer movement.",
        },
        {
          learningText:
            "Hydration helps maintain performance and concentration during exercise.",
          prompt:
            "Based on what you just learned, what does hydration support?",
          options: [
            "Performance and focus",
            "Muscle injuries",
            "Skipping cooldowns",
            "No change in exercise",
          ],
          correctIndex: 0,
          explanation:
            "Water supports physical and mental performance.",
        },
        {
          learningText:
            "A cooldown helps lower heart rate gradually after exercise.",
          prompt:
            "Based on what you just learned, what is the main purpose of a cooldown?",
          options: [
            "To recover safely after activity",
            "To start sprinting faster",
            "To avoid breathing",
            "To increase stress",
          ],
          correctIndex: 0,
          explanation:
            "Cooldowns support a safe return to resting state.",
        },
      ],
      createdBy: sportTeacher._id,
    },
    {
      studentId: johnStudent._id,
      subjectId: sport._id,
      sessionType: "morning",
      title: "John Assessment Sport Mission",
      teacherNote:
        "Assessment mission for John to evaluate understanding of muscles, joints, and movement.",
      source: "bank",
      status: "published",
      publishedAt: new Date(),
      availableOnDate: tomorrowDateKey,
      availableOnDay: tomorrowWeekday,
      xpReward: 50,
      latestScoreCorrect: 0,
      latestScoreTotal: 0,
      latestScorePercent: 0,
      latestXpEarned: 0,
      questions: [
        {
          learningText:
            "Quadriceps extend the knee and hamstrings flex the knee.",
          prompt:
            "Based on what you just learned, which pair is correct?",
          options: [
            "Quadriceps extend, hamstrings flex",
            "Quadriceps flex, hamstrings extend",
            "Both only move the shoulder",
            "Neither affects the knee",
          ],
          correctIndex: 0,
          explanation:
            "This is the correct muscle action pair for the knee.",
        },
        {
          learningText:
            "Fast-twitch fibers support powerful, short actions; slow-twitch support endurance.",
          prompt:
            "Based on what you just learned, which fiber is best for explosive movement?",
          options: [
            "Fast-twitch",
            "Slow-twitch only",
            "No fibers",
            "Bone fibers",
          ],
          correctIndex: 0,
          explanation:
            "Fast-twitch fibers suit explosive activity.",
        },
        {
          learningText:
            "Joints allow bones to move relative to each other.",
          prompt:
            "Based on what you just learned, what do joints mainly do?",
          options: [
            "Allow movement between bones",
            "Store oxygen",
            "Create blood cells",
            "Replace muscles",
          ],
          correctIndex: 0,
          explanation:
            "Joints support movement and body mechanics.",
        },
        {
          learningText:
            "A proper warm-up improves readiness and lowers injury risk.",
          prompt:
            "Based on what you just learned, what is a key benefit of warm-up?",
          options: [
            "Improved readiness",
            "Immediate fatigue",
            "Less circulation",
            "Reduced focus",
          ],
          correctIndex: 0,
          explanation:
            "Warm-ups prepare the body and mind for exercise.",
        },
        {
          learningText:
            "Hydration supports temperature control and concentration.",
          prompt:
            "Based on what you just learned, hydration helps with?",
          options: [
            "Temperature and concentration",
            "Removing the need for rest",
            "Eliminating all injuries",
            "Skipping nutrition",
          ],
          correctIndex: 0,
          explanation:
            "Hydration is essential for stable performance.",
        },
        {
          learningText:
            "Anaerobic effort is high-intensity and short duration.",
          prompt:
            "Based on what you just learned, sprinting is mostly what type of effort?",
          options: [
            "Anaerobic",
            "Always aerobic only",
            "No-energy",
            "Passive",
          ],
          correctIndex: 0,
          explanation:
            "Sprinting relies mainly on anaerobic pathways.",
        },
        {
          learningText:
            "Cooldown lowers heart rate gradually and helps recovery.",
          prompt:
            "Based on what you just learned, why cool down after exercise?",
          options: [
            "To support recovery",
            "To stop breathing quickly",
            "To increase panic",
            "To replace hydration",
          ],
          correctIndex: 0,
          explanation:
            "Cooldown supports safe recovery.",
        },
        {
          learningText:
            "Balance and coordination improve control during movement tasks.",
          prompt:
            "Based on what you just learned, balance mainly improves?",
          options: [
            "Control and stability",
            "Only handwriting",
            "Body temperature loss",
            "Screen brightness",
          ],
          correctIndex: 0,
          explanation:
            "Balance improves control and movement stability.",
        },
        {
          learningText:
            "Muscles create movement by contracting and pulling on bones.",
          prompt:
            "Based on what you just learned, how do muscles move the body?",
          options: [
            "They contract and pull on bones",
            "They push bones from outside",
            "They fill joints with air",
            "They do not affect movement",
          ],
          correctIndex: 0,
          explanation:
            "Muscles contract to move bones at joints.",
        },
        {
          learningText:
            "Endurance activities use energy over longer periods.",
          prompt:
            "Based on what you just learned, slow-twitch fibers are most useful for?",
          options: [
            "Longer-duration activity",
            "Only one-second jumps",
            "No activity",
            "Breaking equipment",
          ],
          correctIndex: 0,
          explanation:
            "Slow-twitch fibers support endurance work.",
        },
      ],
      createdBy: sportTeacher._id,
    },
  ]);

  await Target.create([
    {
      studentId: student._id,
      title: "Complete 5 questions daily",
      description:
        "Build a reliable quiz habit with calm focus sessions.",
      status: "in_progress",
      difficulty: "easy",
      startDate: new Date(),
    },
    {
      studentId: johnStudent._id,
      title: "Complete 5 questions daily",
      description:
        "Build a reliable quiz habit with calm focus sessions.",
      status: "in_progress",
      difficulty: "easy",
      startDate: new Date(),
    },
  ]);

  await Promise.all([
    StudentProgress.create({
      studentId: student._id,
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      criterionState: "learning_required",
      learningStatus: "pending",
      attemptsUsed: 0,
      latestLearningCheckScore: 0,
      appendedBlockIds: [],
      essayText: "",
      wordCount: 0,
      submissionUnlocked: false,
      xpAwarded: 0,
    }),
    StudentProgress.create({
      studentId: johnStudent._id,
      subjectId: english._id,
      unitId: englishNarrativeUnit._id,
      criterionId: characterisationCriterion._id,
      criterionState: "learning_required",
      learningStatus: "pending",
      attemptsUsed: 0,
      latestLearningCheckScore: 0,
      appendedBlockIds: [],
      essayText: "",
      wordCount: 0,
      submissionUnlocked: false,
      xpAwarded: 0,
    }),
    User.findByIdAndUpdate(
      sportTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(
      ictTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(
      businessTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(
      scienceTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(
      englishBotTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(
      mathsBotTeacher._id,
      {
        assignedStudents: [student._id, johnStudent._id],
      },
    ),
    User.findByIdAndUpdate(mentor._id, {
      assignedStudents: [student._id, johnStudent._id],
    }),
  ]);

  console.log("Seed complete.");
  console.log(
    `Student login: student@focusmission.app / ${studentSeedPassword}`,
  );
  console.log(
    `Student login: john@focusmission.app / ${studentSeedPassword}`,
  );
  console.log(
    `Sport teacher login: sport.teacher@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `ICT teacher login: ict.teacher@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `Business teacher login: business.teacher@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `Science teacher login: science.teacher@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `English bot login: english.bot@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `Maths bot login: maths.bot@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `Mentor login: mentor@focusmission.app / ${staffSeedPassword}`,
  );
  console.log(
    `Sample English criterion: ${characterisationCriterion.title}`,
  );

  process.exit(0);
}

seed().catch((error) => {
  console.error("Seed failed", error);
  process.exit(1);
});
