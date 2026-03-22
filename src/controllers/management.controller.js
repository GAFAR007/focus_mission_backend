/**
 * WHAT:
 * management.controller exposes management handlers for student setup,
 * archive recovery, reporting, and timetable configuration.
 * WHY:
 * Management needs a dedicated controller boundary so reporting access stays
 * separate from teacher authoring and mentor support actions while still
 * allowing controlled student lifecycle and timetable setup.
 * HOW:
 * Validate params in routes, call the management/result services, and return a
 * stable JSON response payload.
 */
const managementService = require("../services/management.service");
const resultService = require("../services/result.service");

async function getStudentResults(
  req,
  res,
  next,
) {
  try {
    const results =
      await managementService.listStudentResults(
        {
          managementId: req.user.id,
          studentId: req.params.studentId,
        },
      );
    res.json({ results, missions: results });
  } catch (error) {
    next(error);
  }
}

async function getResultPackage(
  req,
  res,
  next,
) {
  try {
    const resultPackage =
      await resultService.getResultPackageForManagement(
        {
          managementId: req.user.id,
          resultPackageId: req.params.resultPackageId,
        },
      );
    res.json({ resultPackage });
  } catch (error) {
    next(error);
  }
}

async function createUser(
  req,
  res,
  next,
) {
  try {
    const user =
      await managementService.createManagedUser(
        {
          managementId: req.user.id,
          payload: req.body,
        },
      );
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
}

async function archiveStudent(
  req,
  res,
  next,
) {
  try {
    const student =
      await managementService.archiveStudent({
        managementId: req.user.id,
        studentId: req.params.studentId,
      });
    res.json({ student });
  } catch (error) {
    next(error);
  }
}

async function unarchiveStudent(
  req,
  res,
  next,
) {
  try {
    const student =
      await managementService.unarchiveStudent({
        managementId: req.user.id,
        studentId: req.params.studentId,
      });
    res.json({ student });
  } catch (error) {
    next(error);
  }
}

async function updateStudentYearGroup(
  req,
  res,
  next,
) {
  try {
    const student =
      await managementService.updateStudentYearGroup({
        managementId: req.user.id,
        studentId: req.params.studentId,
        payload: req.body,
      });
    res.json({ student });
  } catch (error) {
    next(error);
  }
}

async function getStudents(
  req,
  res,
  next,
) {
  try {
    const students =
      await managementService.listStudents({
        managementId: req.user.id,
        status: req.query.status,
      });
    res.json({ students });
  } catch (error) {
    next(error);
  }
}

async function listSubjects(
  _req,
  res,
  next,
) {
  try {
    const subjects =
      await managementService.listSubjects();
    res.json({ subjects });
  } catch (error) {
    next(error);
  }
}

async function listTeachers(
  _req,
  res,
  next,
) {
  try {
    const teachers =
      await managementService.listTeachers();
    res.json({ teachers });
  } catch (error) {
    next(error);
  }
}

async function getSubjectCertificationSettings(
  req,
  res,
  next,
) {
  try {
    const certification =
      await managementService.getSubjectCertificationSettings(
        {
          subjectId: req.params.subjectId,
        },
      );
    res.json({ certification });
  } catch (error) {
    next(error);
  }
}

async function updateSubjectCertificationSettings(
  req,
  res,
  next,
) {
  try {
    const certification =
      await managementService.updateSubjectCertificationSettings(
        {
          subjectId: req.params.subjectId,
          payload: req.body,
        },
      );
    res.json({ certification });
  } catch (error) {
    next(error);
  }
}

async function getStudentCertification(
  req,
  res,
  next,
) {
  try {
    const certifications =
      await managementService.getStudentCertification(
        {
          managementId: req.user.id,
          studentId: req.params.studentId,
        },
      );
    res.json({
      certifications,
    });
  } catch (error) {
    next(error);
  }
}

async function saveStudentTimetableEntry(
  req,
  res,
  next,
) {
  try {
    const timetable =
      await managementService.saveStudentTimetableEntry(
        {
          managementId: req.user.id,
          studentId: req.params.studentId,
          payload: req.body,
        },
      );
    res.json({ timetable });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  archiveStudent,
  createUser,
  getStudents,
  getStudentResults,
  getResultPackage,
  getStudentCertification,
  getSubjectCertificationSettings,
  listTeachers,
  listSubjects,
  saveStudentTimetableEntry,
  unarchiveStudent,
  updateStudentYearGroup,
  updateSubjectCertificationSettings,
};
